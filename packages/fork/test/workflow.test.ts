import { expect, test } from "bun:test"
import os from "os"
import path from "path"

// Always a fresh database: an inherited OPENCODE_FORK_DB may hold rows from earlier runs.
process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-workflow-${process.pid}-${Date.now()}.db`)
const { ForkWorkflow } = await import("../src/workflow")

const schema = {
  type: "object",
  required: ["n", "tags"],
  properties: { n: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
}

function runtime(runID: string, replies: string[], extra: Partial<Parameters<typeof ForkWorkflow.createRuntime>[0]> = {}) {
  const calls: { prompt: string; sessionID?: string }[] = []
  const rt = ForkWorkflow.createRuntime({
    runID,
    concurrency: 4,
    cost: () => 0.5,
    progress: () => {},
    execute: async (prompt, _options, sessionID) => {
      calls.push({ prompt, sessionID })
      return { text: replies[calls.length - 1] ?? "ok", sessionID: sessionID ?? `ses_${calls.length}` }
    },
    ...extra,
  })
  return { rt, calls }
}

test("keys depend on prompt and options, with an occurrence index for repeats", () => {
  const key = ForkWorkflow.keyer()
  const a = key("p", {})
  const b = key("p", {})
  const c = key("p", { model: "x/y" })
  expect(a.split(":")[0]).toBe(b.split(":")[0])
  expect([a.split(":")[1], b.split(":")[1]]).toEqual(["0", "1"])
  expect(c.split(":")[0]).not.toBe(a.split(":")[0])
  expect(ForkWorkflow.keyer()("p", {})).toBe(a)
})

test("limiter never exceeds its limit and keeps starting queued work", async () => {
  const run = ForkWorkflow.limiter(2)
  const state = { active: 0, peak: 0 }
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      run(async () => {
        state.active++
        state.peak = Math.max(state.peak, state.active)
        await Bun.sleep(10)
        state.active--
        return n
      }),
    ),
  )
  expect(results).toEqual([1, 2, 3, 4, 5])
  expect(state.peak).toBe(2)
})

test("pipeline lets items advance through stages independently", async () => {
  const order: string[] = []
  const errors: number[] = []
  const out = await ForkWorkflow.pipeline(
    [30, 1, 2],
    [
      async (ms) => {
        await Bun.sleep(ms as number)
        order.push(`a${ms}`)
        return ms
      },
      async (ms) => {
        order.push(`b${ms}`)
        if (ms === 2) throw new Error("boom")
        return `done${ms}`
      },
    ],
    (_error, index) => errors.push(index),
  )
  expect(out).toEqual(["done30", "done1", null])
  expect(errors).toEqual([2])
  expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a30"))
})

test("validate checks required keys and types", () => {
  expect(ForkWorkflow.validate(schema, { n: 1, tags: ["a"] })).toEqual([])
  expect(ForkWorkflow.validate(schema, { n: 1.5 })).toEqual(["$.tags: missing", "$.n: expected integer"])
  expect(ForkWorkflow.validate(schema, { n: 1, tags: [1] })).toEqual(["$.tags[0]: expected string"])
  expect(ForkWorkflow.parseAnswer('text\n```json\n{"n":1,"tags":[]}\n```', schema)).toEqual({
    ok: true,
    value: { n: 1, tags: [] },
  })
  expect(ForkWorkflow.parseAnswer("nope", schema).ok).toBe(false)
})

test("replyFrom keeps the text after the last tool call", () => {
  const reply = ForkWorkflow.replyFrom([
    "noise",
    JSON.stringify({ type: "text", sessionID: "s1", part: { text: "thinking" } }),
    JSON.stringify({ type: "tool_use", sessionID: "s1" }),
    JSON.stringify({ type: "text", sessionID: "s1", part: { text: "final" } }),
  ])
  expect(reply).toMatchObject({ sessionID: "s1", text: "final" })
})

test("a resumed run returns cached results instead of re-running", async () => {
  ForkWorkflow.startRun("r1", "s.js", "demo")
  const first = runtime("r1", ["one", "two"])
  expect(await first.rt.agent("same")).toBe("one")
  expect(await first.rt.agent("same")).toBe("two")
  const again = runtime("r1", [])
  expect(await again.rt.agent("same")).toBe("one")
  expect(await again.rt.agent("same")).toBe("two")
  expect(again.calls).toHaveLength(0)
  expect(await again.rt.agent("new")).toBe("ok")
  ForkWorkflow.finishRun("r1", "done")
  expect(ForkWorkflow.hasRun("r1")).toBe(true)
  expect(ForkWorkflow.hasRun("nope")).toBe(false)
})

test("a schema answer is retried once in the same session, then fails", async () => {
  const good = runtime("r2", ["bad", '```json\n{"n":2,"tags":[]}\n```'])
  expect(await good.rt.agent("q", { schema })).toEqual({ n: 2, tags: [] })
  expect(good.calls[1]?.sessionID).toBe("ses_1")

  const bad = runtime("r3", ["bad", "still bad"])
  await expect(bad.rt.agent("q", { schema })).rejects.toThrow("invalid structured answer")
})

test("the budget stops new launches and flags the run", async () => {
  const { rt, calls } = runtime("r4", [], { budget: 0.5 })
  await rt.agent("a")
  expect(rt.halted).toBe(false)
  const results = await rt.parallel([() => rt.agent("b"), () => rt.agent("c")])
  expect(results).toEqual([null, null])
  expect(rt.halted).toBe(true)
  expect(calls).toHaveLength(1)
})

test("parseScriptArgs reports malformed JSON with a clear message", () => {
  expect(ForkWorkflow.parseScriptArgs(undefined)).toEqual({ ok: true, value: undefined })
  expect(ForkWorkflow.parseScriptArgs('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  const bad = ForkWorkflow.parseScriptArgs("{nope")
  expect(bad.ok).toBe(false)
  expect(!bad.ok && bad.message).toStartWith("Invalid --args JSON: ")
})

test("budgetEnv hands each agent the remaining run budget", () => {
  expect(ForkWorkflow.budgetEnv(undefined, 1)).toEqual({})
  expect(ForkWorkflow.budgetEnv(2, 0.5)).toEqual({ OPENCODE_FORK_BUDGET_USD: "1.5" })
  expect(ForkWorkflow.budgetEnv(1, 3)).toEqual({ OPENCODE_FORK_BUDGET_USD: "0" })
})

const { ForkTelemetry } = await import("../src/telemetry")

test("a running run whose process is gone becomes interrupted, and can be resumed", async () => {
  const dead = Bun.spawn(["true"])
  await dead.exited
  ForkWorkflow.startRun("r5", "s.js", "demo")
  ForkWorkflow.startRun("r6", "s.js", "alive")
  ForkTelemetry.db().run("UPDATE fork_workflow_runs SET pid = ? WHERE id = 'r5'", [dead.pid])
  const status = (id: string) => ForkWorkflow.listRuns().find((run) => run.id === id)?.status
  expect(status("r5")).toBe("interrupted")
  expect(status("r6")).toBe("running")
  expect(ForkWorkflow.isRunning("r5")).toBe(false)
  ForkWorkflow.startRun("r5", "s.js", "demo")
  expect(ForkWorkflow.isRunning("r5")).toBe(true)
})

test("the cost of an agent killed mid-turn counts for the run", async () => {
  ForkWorkflow.startRun("r7", "s.js", "demo")
  const rt = ForkWorkflow.createRuntime({
    runID: "r7",
    concurrency: 1,
    progress: () => {},
    execute: async (_prompt, _options, _sessionID, started) => {
      started("ses_killed")
      await ForkTelemetry.record({
        sessionID: "ses_killed",
        messageID: "msg_1",
        providerID: "p",
        modelID: "m",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.25,
      })
      throw new Error("agent killed")
    },
  })
  await expect(rt.agent("work")).rejects.toThrow("agent killed")
  expect(rt.spent()).toBe(0.25)
  ForkWorkflow.finishRun("r7", "failed")
  expect(ForkWorkflow.listRuns().find((run) => run.id === "r7")?.cost).toBe(0.25)
})
