import { afterEach, expect, test } from "bun:test"
import { ForkHooks } from "../src/hooks"

afterEach(() => {
  delete process.env.OPENCODE_FORK_HOOKS
})

const ok = { code: 0, stderr: "" }

test("parse keeps well-formed entries and drops the rest", () => {
  expect(
    ForkHooks.parse({
      PreToolUse: [{ matcher: "bash", command: "./a.sh", timeout: 5 }, { command: " " }, "nope", { command: "b" }],
      Unknown: [{ command: "x" }],
      Stop: "nope",
    }),
  ).toEqual({
    PreToolUse: [
      { type: "command", matcher: "bash", command: "./a.sh", timeout: 5 },
      { type: "command", command: "b" },
    ],
  })
  expect(ForkHooks.parse(undefined)).toEqual({})
})

test("parse accepts every event and the http and prompt types", () => {
  const entry = { command: "x" }
  expect(Object.keys(ForkHooks.parse(Object.fromEntries(ForkHooks.EVENTS.map((event) => [event, [entry]]))))).toEqual([
    ...ForkHooks.EVENTS,
  ])
  expect(
    ForkHooks.parse({
      PostToolUseFailure: [
        { type: "http", url: "http://localhost:1/x", headers: { a: "$A", b: 1 }, timeout: 9 },
        { type: "http", url: "ftp://nope" },
        { type: "http" },
        { type: "prompt", prompt: "check $ARGUMENTS", matcher: "bash" },
        { type: "prompt", prompt: " " },
        { type: "weird", command: "x" },
      ],
    }),
  ).toEqual({
    PostToolUseFailure: [
      { type: "http", url: "http://localhost:1/x", headers: { a: "$A" }, timeout: 9 },
      { type: "prompt", prompt: "check $ARGUMENTS", matcher: "bash" },
    ],
  })
})

test("select matches the whole tool name, case-insensitively", () => {
  const hooks = ForkHooks.parse({
    PreToolUse: [{ matcher: "bash|edit", command: "a" }, { matcher: "(", command: "bad" }, { command: "all" }],
  })
  const names = (name: string) => ForkHooks.select(hooks, "PreToolUse", name).map(ForkHooks.describe)
  expect(names("bash")).toEqual(["a", "all"])
  expect(names("Edit")).toEqual(["a", "all"])
  expect(names("bashful")).toEqual(["all"])
  expect(ForkHooks.select(hooks, "Stop")).toEqual([])
})

test("interpret maps exit codes and JSON stdout", () => {
  expect(ForkHooks.interpret({ ...ok, stdout: "" })).toEqual({})
  expect(ForkHooks.interpret({ ...ok, stdout: "plain text" })).toEqual({})
  expect(ForkHooks.interpret({ code: 2, stdout: "", stderr: " no rm \n" })).toEqual({
    decision: "block",
    reason: "no rm",
  })
  expect(ForkHooks.interpret({ code: 2, stdout: "", stderr: "" }).reason).toBe("Blocked by hook")
  expect(ForkHooks.interpret({ code: 1, stdout: "", stderr: "boom" })).toEqual({ error: "boom" })
  expect(ForkHooks.interpret({ code: null, stdout: "", stderr: "", timedOut: true })).toEqual({
    error: "hook timed out",
  })
  expect(
    ForkHooks.interpret({
      ...ok,
      stdout: JSON.stringify({ decision: "deny", reason: "r", additionalContext: "c", args: { a: 1 } }),
    }),
  ).toEqual({ decision: "deny", reason: "r", additionalContext: "c", args: { a: 1 } })
  expect(ForkHooks.interpret({ ...ok, stdout: '{"decision":"maybe","args":[1]}' })).toEqual({})
  expect(ForkHooks.interpret({ ...ok, stdout: "{broken" })).toEqual({})
})

test("combine keeps the strictest decision, joins contexts and takes the last args", () => {
  expect(
    ForkHooks.combine([
      { decision: "allow", reason: "a", additionalContext: "one", args: { x: 1 } },
      { decision: "deny", reason: "d" },
      { decision: "ask", additionalContext: "two", args: { x: 2 } },
    ]),
  ).toEqual({ decision: "deny", reason: "d", additionalContext: "one\ntwo", args: { x: 2 } })
  expect(ForkHooks.combine([{ error: "e" }])).toEqual({})
  expect(ForkHooks.blocked({ decision: "block" })).toBe(true)
  expect(ForkHooks.blocked({ decision: "ask" })).toBe(false)
})

test("run feeds the payload on stdin and exposes the event in the environment", async () => {
  const cwd = process.cwd()
  expect(
    await ForkHooks.run(
      { type: "command", command: 'grep -q \'"tool":"bash"\' && echo "{\\"additionalContext\\":\\"$OPENCODE_HOOK_EVENT\\"}"' },
      { event: "PreToolUse", cwd, tool: "bash" },
    ),
  ).toEqual({ additionalContext: "PreToolUse" })
})

test("run reports exit 2 as a block and a timeout as a non-blocking error", async () => {
  const cwd = process.cwd()
  expect(await ForkHooks.run({ type: "command", command: "echo nope >&2; exit 2" },{ event: "PreToolUse", cwd })).toEqual({
    decision: "block",
    reason: "nope",
  })
  const started = Date.now()
  expect(await ForkHooks.run({ type: "command", command: "sleep 5", timeout: 100 },{ event: "Stop", cwd })).toEqual({
    error: "hook timed out",
  })
  expect(Date.now() - started).toBeLessThan(2000)
})

test.skipIf(process.platform === "win32")("a timeout kills the whole process group", async () => {
  const marker = `30.${process.pid}${Date.now() % 100000}`
  const alive = async () => {
    const out = await Bun.$`pgrep -f ${`sleep ${marker}`}`.nothrow().text()
    return out.split("\n").filter(Boolean).map(Number)
  }
  const outcome = await ForkHooks.run(
    { type: "command", command: `sleep ${marker} &sleep ${marker}`, timeout: 500 },
    { event: "Stop", cwd: process.cwd() },
  )
  const leftovers = await alive()
  leftovers.forEach((pid) => process.kill(pid, "SIGKILL"))
  expect(outcome).toEqual({ error: "hook timed out" })
  expect(leftovers).toEqual([])
})

const cwd = process.cwd()

test("http hooks post the event JSON with expanded headers and follow the stdout contract", async () => {
  process.env.FORK_HOOK_TOKEN = "s3cret"
  const seen: { body: unknown; auth: string | null; type: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      seen.push({
        body: await request.json(),
        auth: request.headers.get("authorization"),
        type: request.headers.get("content-type"),
      })
      if (path === "/deny") return Response.json({ decision: "deny", reason: "nope", additionalContext: "ctx" })
      if (path === "/text") return new Response("fine")
      if (path === "/slow") {
        await Bun.sleep(2000)
        return Response.json({ decision: "deny" })
      }
      return new Response("bad", { status: 500 })
    },
  })
  const url = (path: string) => `http://localhost:${server.port}${path}`
  const event = { event: "PostToolUseFailure" as const, cwd, tool: "bash", error: "boom" }
  const headers = { authorization: "Bearer $FORK_HOOK_TOKEN" }

  expect(await ForkHooks.run({ type: "http", url: url("/deny"), headers }, event)).toEqual({
    decision: "deny",
    reason: "nope",
    additionalContext: "ctx",
  })
  expect(seen[0]).toEqual({ body: event, auth: "Bearer s3cret", type: "application/json" })
  expect(await ForkHooks.run({ type: "http", url: url("/text") }, event)).toEqual({})
  expect(await ForkHooks.run({ type: "http", url: url("/fail") }, event)).toEqual({ error: "hook returned HTTP 500" })
  expect(await ForkHooks.run({ type: "http", url: url("/slow"), timeout: 100 }, event)).toEqual({
    error: "hook timed out",
  })
  server.stop(true)
  expect((await ForkHooks.run({ type: "http", url: url("/deny"), timeout: 1000 }, event)).error).toBeString()
  delete process.env.FORK_HOOK_TOKEN
})

test("prompt hooks send the substituted prompt to the injected model and map ok=false to a block", async () => {
  const prompts: string[] = []
  const answer = (text: string) => ({
    ask: async (prompt: string) => {
      prompts.push(prompt)
      return text
    },
  })
  const event = { event: "SubagentStop" as const, cwd, sessionID: "child", parentID: "root", agent: "explore" }
  const entry = { type: "prompt" as const, prompt: "Is this fine? $ARGUMENTS" }

  expect(await ForkHooks.run(entry, event, answer('{"ok":true}'))).toEqual({})
  expect(prompts[0]).toStartWith(`Is this fine? ${JSON.stringify(event)}`)
  expect(await ForkHooks.run(entry, event, answer('```json\n{"ok":false,"reason":"too risky"}\n```'))).toEqual({
    decision: "block",
    reason: "too risky",
  })
  expect(await ForkHooks.run(entry, event, answer('{"ok":false}'))).toEqual({
    decision: "block",
    reason: "Blocked by prompt hook",
  })
  expect((await ForkHooks.run(entry, event, answer("sure"))).error).toContain("{ ok, reason }")
  expect(
    await ForkHooks.run(entry, event, {
      ask: async () => {
        throw new Error("no model")
      },
    }),
  ).toEqual({ error: "prompt hook failed: no model" })
  expect(await ForkHooks.run({ ...entry, timeout: 50 }, event, { ask: () => new Promise(() => {}) })).toEqual({
    error: "hook timed out",
  })
  expect((await ForkHooks.run(entry, event)).error).toContain("model access")
})

test("runAll mixes hook types and the strictest decision wins", async () => {
  const outcome = await ForkHooks.runAll(
    [
      { type: "command", command: 'echo \'{"additionalContext":"a"}\'' },
      { type: "prompt", prompt: "p" },
    ],
    { event: "PreToolUse", cwd },
    undefined,
    { ask: async () => '{"ok":false,"reason":"no"}' },
  )
  expect(outcome).toEqual({ decision: "block", reason: "no", additionalContext: "a" })
})

test("enabled honours OPENCODE_FORK_HOOKS=0", () => {
  expect(ForkHooks.enabled()).toBe(true)
  process.env.OPENCODE_FORK_HOOKS = "0"
  expect(ForkHooks.enabled()).toBe(false)
})
