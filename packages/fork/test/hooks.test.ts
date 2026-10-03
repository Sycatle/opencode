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
  ).toEqual({ PreToolUse: [{ matcher: "bash", command: "./a.sh", timeout: 5 }, { command: "b" }] })
  expect(ForkHooks.parse(undefined)).toEqual({})
})

test("select matches the whole tool name, case-insensitively", () => {
  const hooks = ForkHooks.parse({
    PreToolUse: [{ matcher: "bash|edit", command: "a" }, { matcher: "(", command: "bad" }, { command: "all" }],
  })
  expect(ForkHooks.select(hooks, "PreToolUse", "bash").map((e) => e.command)).toEqual(["a", "all"])
  expect(ForkHooks.select(hooks, "PreToolUse", "Edit").map((e) => e.command)).toEqual(["a", "all"])
  expect(ForkHooks.select(hooks, "PreToolUse", "bashful").map((e) => e.command)).toEqual(["all"])
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
      { command: 'grep -q \'"tool":"bash"\' && echo "{\\"additionalContext\\":\\"$OPENCODE_HOOK_EVENT\\"}"' },
      { event: "PreToolUse", cwd, tool: "bash" },
    ),
  ).toEqual({ additionalContext: "PreToolUse" })
})

test("run reports exit 2 as a block and a timeout as a non-blocking error", async () => {
  const cwd = process.cwd()
  expect(await ForkHooks.run({ command: "echo nope >&2; exit 2" }, { event: "PreToolUse", cwd })).toEqual({
    decision: "block",
    reason: "nope",
  })
  const started = Date.now()
  expect(await ForkHooks.run({ command: "sleep 5", timeout: 100 }, { event: "Stop", cwd })).toEqual({
    error: "hook timed out",
  })
  expect(Date.now() - started).toBeLessThan(2000)
})

test("enabled honours OPENCODE_FORK_HOOKS=0", () => {
  expect(ForkHooks.enabled()).toBe(true)
  process.env.OPENCODE_FORK_HOOKS = "0"
  expect(ForkHooks.enabled()).toBe(false)
})
