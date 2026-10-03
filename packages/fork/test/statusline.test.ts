import { afterEach, expect, test } from "bun:test"
import { ForkStatusline } from "../src/statusline"

afterEach(() => {
  delete process.env.OPENCODE_FORK_BACKGROUND_NOTIFY
})

test("config needs a command and clamps the interval", () => {
  expect(ForkStatusline.config(undefined)).toBeUndefined()
  expect(ForkStatusline.config({ command: "  " })).toBeUndefined()
  expect(ForkStatusline.config({ command: "echo hi" })).toEqual({ command: "echo hi", interval: 5000 })
  expect(ForkStatusline.config({ command: "x", interval: 10 })?.interval).toBe(1000)
  expect(ForkStatusline.config({ command: "x", interval: 30000 })?.interval).toBe(30000)
})

test("input carries only session, model, agent and cwd", () => {
  const data = { sessionID: "s", model: { providerID: "p", modelID: "m" }, agent: "build", cwd: "/p" }
  expect(JSON.parse(ForkStatusline.input(data))).toEqual(data)
})

test("firstLine strips ANSI, skips blanks and truncates", () => {
  expect(ForkStatusline.firstLine("\n\u001b[32mgreen\u001b[0m line\nsecond", 80)).toBe("green line")
  expect(ForkStatusline.firstLine("abcdefgh", 3)).toBe("abc")
  expect(ForkStatusline.firstLine("", 10)).toBe("")
})

test("finished parses synthetic job messages", () => {
  expect(ForkStatusline.finished('<task id="ses_1" state="completed">\nx')).toEqual({ kind: "task", state: "completed" })
  expect(ForkStatusline.finished('<shell id="job_1" state="error" exit="2">\nx')).toEqual({
    kind: "shell",
    state: "error",
    exit: 2,
  })
  expect(ForkStatusline.finished('<task id="a" state="running">')).toBeUndefined()
  expect(ForkStatusline.finished("hello <task")).toBeUndefined()
})

test("notification titles", () => {
  expect(ForkStatusline.notification({ kind: "task", state: "completed" })).toBe("Subagent done")
  expect(ForkStatusline.notification({ kind: "shell", state: "completed", exit: 0 })).toBe(
    "Background command done (exit 0)",
  )
  expect(ForkStatusline.notification({ kind: "shell", state: "error", exit: 1 })).toBe(
    "Background command failed (exit 1)",
  )
})

test("background notify can be disabled", () => {
  expect(ForkStatusline.backgroundNotifyEnabled()).toBe(true)
  process.env.OPENCODE_FORK_BACKGROUND_NOTIFY = "0"
  expect(ForkStatusline.backgroundNotifyEnabled()).toBe(false)
})
