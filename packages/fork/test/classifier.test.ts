import { expect, test } from "bun:test"
import { ForkClassifier } from "../src/classifier"

test("the mode marker round-trips through the session ruleset and replaces itself", () => {
  const base = [{ permission: "question", pattern: "*", action: "deny" as const }]
  expect(ForkClassifier.storedMode(base)).toBeUndefined()
  const auto = ForkClassifier.withMode(base, "auto")
  expect(ForkClassifier.storedMode(auto)).toBe("auto")
  expect(
    ForkClassifier.storedMode([
      { permission: ForkClassifier.MODE_PERMISSION, pattern: "acceptEdits", action: "allow" },
    ]),
  ).toBe("normal")
  expect(auto.filter((rule) => rule.permission === ForkClassifier.MODE_PERMISSION)).toHaveLength(1)
  expect(ForkClassifier.withMode(auto, "normal")).toEqual(base)
})

test("modes cycle build, plan, auto, build", () => {
  const seen = ["normal" as ForkClassifier.Mode]
  for (const _ of [1, 2, 3]) seen.push(ForkClassifier.next(seen.at(-1)!))
  expect(seen).toEqual(["normal", "plan", "auto", "normal"])
  expect(ForkClassifier.current(undefined, "plan")).toBe("plan")
  expect(ForkClassifier.current("normal", "build")).toBe("normal")
})

test("leaving the sandbox is never approved automatically", () => {
  expect(ForkClassifier.neverAuto("sandbox_escape")).toBe(true)
  expect(ForkClassifier.neverAuto("bash")).toBe(false)
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
  const sessionID = crypto.randomUUID()
  ForkClassifier.record({
    sessionID,
    permission: "bash",
    patterns: ["ls *"],
    metadata: { command: "ls" },
    decision: "deny",
    reason: "outside project",
    cost: 0.001,
    providerID: "anthropic",
    modelID: "claude-haiku-4-5",
  })
  expect(ForkClassifier.decisions(sessionID)).toMatchObject([
    { permission: "bash", decision: "deny", reason: "outside project", cost: 0.001 },
  ])
})

const risk = (choice: string, confidence: number, requested?: number) => ({
  risk: { choice, confidence },
  ...(requested === undefined ? {} : { requested: { noul: requested } }),
})

test("Jev asks the user on a confident danger and approves only a confident, requested, in-scope action", () => {
  expect(ForkClassifier.jevVerdict(risk("destructive", 0.8), false)).toEqual({
    decision: "ask",
    reason: "Jev: destructive (0.80)",
  })
  expect(ForkClassifier.jevVerdict(risk("outside_project", 0.7), false)?.decision).toBe("ask")
  expect(ForkClassifier.jevVerdict(risk("secrets", 0.6), false)).toBeUndefined()
  expect(ForkClassifier.jevVerdict(risk("in_scope_safe", 0.95, 0.9), false)?.decision).toBe("allow")
  expect(ForkClassifier.jevVerdict(risk("in_scope_safe", 0.85, 0.9), false)).toBeUndefined()
  expect(ForkClassifier.jevVerdict(risk("in_scope_safe", 0.95, 0.5), false)).toBeUndefined()
  expect(ForkClassifier.jevVerdict(risk("in_scope_safe", 0.95), false)).toBeUndefined()
  // Never an approval on Jev's word alone after an injection.
  expect(ForkClassifier.jevVerdict(risk("in_scope_safe", 0.99, 0.99), true)).toBeUndefined()
  expect(ForkClassifier.jevVerdict(risk("destructive", 0.99), true)?.decision).toBe("ask")
  expect(ForkClassifier.jevVerdict(risk("unclear", 0.99), false)).toBeUndefined()
  expect(ForkClassifier.jevVerdict(undefined, false)).toBeUndefined()
  expect(ForkClassifier.jevVerdict({ requested: { noul: 1 } }, false)).toBeUndefined()
})

test("the Jev request masks the project and home directories and keeps only a few fields", () => {
  const request = ForkClassifier.jevRequest({
    action: {
      permission: "bash",
      patterns: ["cat /home/me/app/.env"],
      metadata: { command: "cat /home/me/app/.env", diff: "SECRET=hunter2", description: "read env" },
    },
    directory: "/home/me/app",
    home: "/home/me",
    lastUser: "show me /home/me/notes",
  })
  expect(request.state).toContain("permission: bash")
  expect(request.state).toContain("patterns: cat ./.env")
  expect(request.state).toContain("command: cat ./.env")
  expect(request.state).toContain("show me ~/notes")
  expect(request.state).not.toContain("hunter2")
  expect(request.state).not.toContain("read env")
  expect(request.state).not.toContain("/home/me")
  expect(Object.keys(request.questions)).toEqual(["risk", "requested"])
  expect(Object.keys(request.questions.risk.criteria)).toContain("in_scope_safe")
})
