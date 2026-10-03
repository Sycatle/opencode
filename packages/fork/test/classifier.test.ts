import { expect, test } from "bun:test"
import { ForkClassifier } from "../src/classifier"

test("the mode marker round-trips through the session ruleset and replaces itself", () => {
  const base = [{ permission: "question", pattern: "*", action: "deny" as const }]
  expect(ForkClassifier.storedMode(base)).toBeUndefined()
  const auto = ForkClassifier.withMode(base, "auto")
  expect(ForkClassifier.storedMode(auto)).toBe("auto")
  const edits = ForkClassifier.withMode(auto, "acceptEdits")
  expect(ForkClassifier.storedMode(edits)).toBe("acceptEdits")
  expect(edits.filter((rule) => rule.permission === ForkClassifier.MODE_PERMISSION)).toHaveLength(1)
  expect(ForkClassifier.withMode(edits, "normal")).toEqual(base)
})

test("modes cycle build, accept edits, plan, auto, build", () => {
  const seen = ["normal" as ForkClassifier.Mode]
  for (const _ of [1, 2, 3, 4]) seen.push(ForkClassifier.next(seen.at(-1)!))
  expect(seen).toEqual(["normal", "acceptEdits", "plan", "auto", "normal"])
  expect(ForkClassifier.current(undefined, "plan")).toBe("plan")
  expect(ForkClassifier.current("auto", "plan")).toBe("auto")
  expect(ForkClassifier.current("normal", "build")).toBe("normal")
})

test("accept-edits only approves the edit permission", () => {
  expect(ForkClassifier.acceptsEdit("acceptEdits", "edit")).toBe(true)
  expect(ForkClassifier.acceptsEdit("acceptEdits", "bash")).toBe(false)
  expect(ForkClassifier.acceptsEdit("auto", "edit")).toBe(false)
})

test("leaving the sandbox is never approved automatically", () => {
  expect(ForkClassifier.neverAuto("sandbox_escape")).toBe(true)
  expect(ForkClassifier.neverAuto("bash")).toBe(false)
})

test("the classifier can be switched off", () => {
  expect(ForkClassifier.enabled({})).toBe(true)
  expect(ForkClassifier.enabled({ OPENCODE_FORK_AUTO_CLASSIFIER: "0" })).toBe(false)
})

test("parses a verdict, tolerating fences and prose, and rejects anything else", () => {
  expect(ForkClassifier.parse('{"decision":"allow","reason":"reads a project file"}')).toEqual({
    decision: "allow",
    reason: "reads a project file",
  })
  expect(ForkClassifier.parse('```json\n{"decision":"deny","reason":"git push"}\n```')?.decision).toBe("deny")
  expect(ForkClassifier.parse('{"decision":"deny"}')?.reason).toBe("no reason given")
  expect(ForkClassifier.parse('{"decision":"maybe","reason":"x"}')).toBeUndefined()
  expect(ForkClassifier.parse("allow")).toBeUndefined()
  expect(ForkClassifier.parse("{not json}")).toBeUndefined()
})

test("the prompt carries the action, the last user message and the transcript, and names the risky classes", () => {
  const text = ForkClassifier.prompt({
    action: { permission: "bash", patterns: ["git push *"], metadata: { command: "git push --force origin main" } },
    directory: "/work/app",
    lastUser: "fix the failing test",
    transcript: [
      { role: "user", text: "fix the failing test" },
      { role: "assistant", text: "Running the suite" },
    ],
  })
  expect(text).toContain("permission: bash")
  expect(text).toContain("command: git push --force origin main")
  expect(text).toContain("fix the failing test")
  expect(text).toContain("assistant: Running the suite")
  for (const risk of ["rm -rf", "git push --force", "publishing", "outside the project", "secrets"])
    expect(text.toLowerCase()).toContain(risk.toLowerCase())
})

test("the transcript excerpt keeps the most recent lines within budget", () => {
  const lines = Array.from({ length: 100 }, (_, index) => ({
    role: "user" as const,
    text: `line ${index} ${"x".repeat(200)}`,
  }))
  const out = ForkClassifier.excerpt(lines)
  expect(out.length).toBeLessThanOrEqual(2400)
  expect(out).toContain("line 99")
  expect(out).not.toContain("line 0 ")
})

test("decisions are recorded in fork.db", () => {
  ForkClassifier.record({
    sessionID: "ses_classifier_test",
    permission: "bash",
    patterns: ["ls *"],
    metadata: { command: "ls" },
    decision: "deny",
    reason: "outside project",
    cost: 0.001,
    providerID: "anthropic",
    modelID: "claude-haiku-4-5",
  })
  expect(ForkClassifier.decisions("ses_classifier_test")).toMatchObject([
    { permission: "bash", decision: "deny", reason: "outside project", cost: 0.001 },
  ])
})
