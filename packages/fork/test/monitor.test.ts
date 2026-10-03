import { expect, test } from "bun:test"
import { ForkMonitor } from "../src/monitor"

test("normalize applies defaults per source", () => {
  expect(ForkMonitor.normalize({ id: "j", pattern: "ready" })).toMatchObject({ until: "match", timeoutMs: 600_000 })
  expect(ForkMonitor.normalize({ id: "j" })).toMatchObject({ until: "exit", background: false })
  expect(ForkMonitor.normalize({ command: "true", interval_ms: 10 })).toMatchObject({ until: "success", intervalMs: 500 })
  expect(ForkMonitor.normalize({ command: "true", timeout_ms: 99_999_999 })).toMatchObject({ timeoutMs: 3_600_000 })
})

test("normalize rejects inconsistent input", () => {
  expect(ForkMonitor.normalize({})).toBeTypeOf("string")
  expect(ForkMonitor.normalize({ command: "x", pattern: "a" })).toBeTypeOf("string")
  expect(ForkMonitor.normalize({ id: "j", pattern: "(" })).toContain("Invalid pattern")
  expect(ForkMonitor.normalize({ id: "j", until: "match" })).toBeTypeOf("string")
  expect(ForkMonitor.normalize({ command: "x", until: "exit" })).toBeTypeOf("string")
})

test("feed carries a partial line and reports context", () => {
  const re = /ready/
  const first = ForkMonitor.feed(ForkMonitor.emptyFeed, "a\nb\nrea", re)
  expect(first.hit).toBeUndefined()
  expect(first.state).toEqual({ carry: "rea", recent: ["a", "b"] })
  const second = ForkMonitor.feed(first.state, "dy\nx\ny\n", re)
  expect(second.hit).toEqual({ line: "ready", before: ["a", "b"], after: ["x", "y"] })
})

test("feed ignores an unterminated line and strips CR", () => {
  expect(ForkMonitor.feed(ForkMonitor.emptyFeed, "ready", /ready/).hit).toBeUndefined()
  expect(ForkMonitor.feed(ForkMonitor.emptyFeed, "ready\r\n", /ready/).hit?.line).toBe("ready")
})

test("decide follows the until condition", () => {
  expect(ForkMonitor.decide({ until: "success", hasCommand: true, jobEnded: true, commandExit: 1 })).toBeUndefined()
  expect(ForkMonitor.decide({ until: "success", hasCommand: true, jobEnded: false, commandExit: 0 })).toBe("success")
  expect(ForkMonitor.decide({ until: "exit", hasCommand: false, jobEnded: false })).toBeUndefined()
  expect(ForkMonitor.decide({ until: "match", hasCommand: false, jobEnded: true })).toBe("exit")
  expect(ForkMonitor.decide({ until: "success", hasCommand: false, jobEnded: true })).toBe("exit")
})

test("render covers every outcome", () => {
  expect(ForkMonitor.render({ kind: "match", hit: { line: "ready", before: ["a"], after: ["b"] } })).toBe(
    "Pattern matched:\na\n> ready\nb",
  )
  expect(ForkMonitor.render({ kind: "exit", exit: 2, tail: "boom" })).toBe("Job exited with code 2.\nboom")
  expect(ForkMonitor.render({ kind: "success", attempts: 1, tail: "" })).toBe("Command succeeded after 1 attempt.")
  expect(ForkMonitor.render({ kind: "timeout", timeoutMs: 5, attempts: 3, lastExit: 1 })).toContain("Last command exit: 1")
  expect(
    ForkMonitor.renderMessage({ id: "j", output: ForkMonitor.result({ kind: "exit", exit: 0, tail: "bye" }) }),
  ).toBe(`<monitor id="j" state="exit">\nJob exited with code 0.\nbye\n</monitor>`)
})
