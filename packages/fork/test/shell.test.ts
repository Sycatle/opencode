import { afterEach, expect, test } from "bun:test"
import { ForkShell } from "../src/shell"

afterEach(() => {
  delete process.env.OPENCODE_FORK_BACKGROUND_SHELL
  delete process.env.OPENCODE_FORK_MAX_BACKGROUND
})

test("enabled unless opted out", () => {
  expect(ForkShell.enabled()).toBe(true)
  process.env.OPENCODE_FORK_BACKGROUND_SHELL = "0"
  expect(ForkShell.enabled()).toBe(false)
})

test("cap follows the background limit", () => {
  process.env.OPENCODE_FORK_MAX_BACKGROUND = "2"
  expect(ForkShell.atCap(1)).toBe(false)
  expect(ForkShell.atCap(2)).toBe(true)
  expect(ForkShell.capMessage(2)).toContain("limit 2")
})

test("tail keeps the last lines", () => {
  expect(ForkShell.tail("a\nb\nc\n", 2)).toBe("b\nc")
  expect(ForkShell.tail("a", 5)).toBe("a")
  expect(ForkShell.tail("", 5)).toBe("")
})

test("result round-trips the exit code", () => {
  expect(ForkShell.parseResult(ForkShell.result(3, "x\ny"))).toEqual({ exit: 3, tail: "x\ny" })
  expect(ForkShell.parseResult(ForkShell.result(null, "")).exit).toBeNull()
})

test("message carries state, exit and a bounded tail", () => {
  const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n")
  const out = ForkShell.renderMessage({ id: "job_1", state: "completed", exit: 0, tail: text, outputPath: "/tmp/o" })
  expect(out).toContain(`<shell id="job_1" state="completed" exit="0">`)
  expect(out).toContain("l49")
  expect(out).not.toContain("l29\n")
  expect(out).toContain("/tmp/o")
})
