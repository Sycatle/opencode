import { afterEach, expect, test } from "bun:test"
import { ForkDescriptions } from "../src/descriptions"

afterEach(() => {
  delete process.env.OPENCODE_FORK_SLIM_TOOLS
})

// Markers copied from upstream's rendered bash description.
const bash = (shell: string) =>
  [
    "Executes a given bash command in a persistent shell session.",
    `Be aware: OS: linux, Shell: ${shell}`,
    "Use `/tmp/opencode` for temporary work outside the workspace.",
    "You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.",
    "If the output exceeds 640 lines or 16384 bytes, it will be truncated.",
    "x".repeat(4000),
  ].join("\n")

test("bash keeps its runtime values and gets much shorter", () => {
  const original = bash("bash")
  const slim = ForkDescriptions.slim("bash", original)
  expect(slim).toContain("OS: linux, shell: bash")
  expect(slim).toContain("`/tmp/opencode`")
  expect(slim).toContain("120000ms")
  expect(slim).toContain("640 lines or 16384 bytes")
  expect(slim.length).toBeLessThan(original.length / 3)
})

test("non-POSIX shells and unrecognized text keep the upstream description", () => {
  expect(ForkDescriptions.slim("bash", bash("pwsh"))).toBe(bash("pwsh"))
  expect(ForkDescriptions.slim("bash", "changed upstream wording")).toBe("changed upstream wording")
})

test("task keeps the background section when it is enabled", () => {
  const slim = ForkDescriptions.slim("task", "Long upstream text.\n\nBackground mode: background=true launches...")
  expect(slim).toContain("Launch a subagent")
  expect(slim).toEndWith("Background mode: background=true launches...")
  expect(ForkDescriptions.slim("task", "Long upstream text.")).not.toContain("Background mode")
})

test("unknown tools and the opt-out keep the original", () => {
  expect(ForkDescriptions.slim("custom_tool", "original")).toBe("original")
  process.env.OPENCODE_FORK_SLIM_TOOLS = "0"
  expect(ForkDescriptions.slim("read", "original")).toBe("original")
})

test("task mentions inherit and messaging a running background subagent", () => {
  const slim = ForkDescriptions.slim("task", "Long upstream text.")
  expect(slim).toContain("inherit: true forks the current context")
  expect(slim).toContain("task_id of a running background subagent sends it a new message")
})
