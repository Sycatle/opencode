import { afterEach, expect, test } from "bun:test"
import { ForkPromptSuggestion } from "../src/prompt-suggestion"

afterEach(() => {
  delete process.env.OPENCODE_FORK_PROMPT_SUGGESTION
})

const gate = (over: Partial<ForkPromptSuggestion.Gate> = {}): ForkPromptSuggestion.Gate => ({
  enabled: true,
  agent: "build",
  last: { role: "assistant", finish: "stop" },
  pendingQuestion: false,
  text: "Done, the fix is in.",
  ...over,
})

test("the env var switches it off", () => {
  expect(ForkPromptSuggestion.enabled({})).toBe(true)
  expect(ForkPromptSuggestion.enabled({ OPENCODE_FORK_PROMPT_SUGGESTION: "0" })).toBe(false)
})

test("only the TUI process is interactive", () => {
  expect(ForkPromptSuggestion.interactive({})).toBe(false)
  expect(ForkPromptSuggestion.interactive({ OPENCODE_FORK_INTERACTIVE: "1" })).toBe(true)
})

test("the prompt keeps the last user message and the end of the reply within the input cap", () => {
  const long = "x".repeat(20_000)
  const text = ForkPromptSuggestion.prompt({
    turns: [
      { role: "user", text: "old request one" },
      { role: "user", text: "old request two" },
      { role: "user", text: "fix the login bug" },
      { role: "assistant", text: `${long} THE END` },
    ],
    todos: [
      { content: "write the fix", status: "completed" },
      { content: "run the tests", status: "pending" },
    ],
  })
  expect(text.length).toBeLessThanOrEqual(ForkPromptSuggestion.MAX_INPUT_CHARS)
  expect(text).toContain("fix the login bug")
  expect(text).toContain("THE END")
  expect(text).toContain("- [pending] run the tests")
  expect(text).toContain("- old request two")
})

test("a prompt without a todo or earlier messages has no empty sections", () => {
  const text = ForkPromptSuggestion.prompt({
    turns: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
  })
  expect(text).not.toContain("Todo\n")
  expect(text).not.toContain("Earlier user messages")
})

test("skips subagents, errors, unfinished turns, plan questions and empty replies", () => {
  expect(ForkPromptSuggestion.skip(gate())).toBeUndefined()
  expect(ForkPromptSuggestion.skip(gate({ enabled: false }))).toBe("disabled")
  expect(ForkPromptSuggestion.skip(gate({ parentID: "ses_1" }))).toBe("subagent")
  expect(ForkPromptSuggestion.skip(gate({ last: { role: "user" } }))).toBe("no-assistant")
  expect(ForkPromptSuggestion.skip(gate({ last: { role: "assistant", finish: "stop", error: true } }))).toBe("errored")
  expect(ForkPromptSuggestion.skip(gate({ last: { role: "assistant", finish: "tool-calls" } }))).toBe("not-finished")
  expect(ForkPromptSuggestion.skip(gate({ agent: "plan", pendingQuestion: true }))).toBe("plan-question")
  expect(ForkPromptSuggestion.skip(gate({ agent: "build", pendingQuestion: true }))).toBeUndefined()
  expect(ForkPromptSuggestion.skip(gate({ text: "  " }))).toBe("empty")
})

test("cleans the answer to one line without quotes", () => {
  expect(ForkPromptSuggestion.clean('"lance les tests e2e"')).toBe("lance les tests e2e")
  expect(ForkPromptSuggestion.clean("« pousse sur main »")).toBe("pousse sur main")
  expect(ForkPromptSuggestion.clean("\n\n- run the tests\nsecond line")).toBe("run the tests")
  expect(ForkPromptSuggestion.clean("Suggestion: commit this")).toBe("commit this")
  expect(ForkPromptSuggestion.clean("`git push`")).toBe("git push")
})

test("rejects empty, NONE, meta and agent-voiced answers", () => {
  for (const text of [
    "",
    "   ",
    "NONE",
    "none.",
    "N/A",
    "(no suggestion)",
    "I suggest running the tests",
    "The user may want to deploy",
    "Would you like me to run the tests?",
    "Let me run the tests",
    "x".repeat(150),
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen",
  ])
    expect(ForkPromptSuggestion.clean(text)).toBeUndefined()
})

test("records the cost of every call and reads the latest row of a session", () => {
  expect(ForkPromptSuggestion.latest("ses_a")).toBeNull()
  ForkPromptSuggestion.record({ sessionID: "ses_a", messageID: "msg_1", text: "run the tests", cost: 0.0004 })
  ForkPromptSuggestion.record({
    sessionID: "ses_a",
    messageID: "msg_2",
    cost: 0.0003,
    providerID: "anthropic",
    modelID: "haiku",
  })
  expect(ForkPromptSuggestion.latest("ses_a")).toMatchObject({ message_id: "msg_2", text: null })
  expect(ForkPromptSuggestion.cost("ses_a")).toBeCloseTo(0.0007)
  expect(ForkPromptSuggestion.latest("ses_b")).toBeNull()
})

test("the palette toggle is stored in fork.db", () => {
  expect(ForkPromptSuggestion.userEnabled()).toBe(true)
  ForkPromptSuggestion.setUserEnabled(false)
  expect(ForkPromptSuggestion.userEnabled()).toBe(false)
  ForkPromptSuggestion.setUserEnabled(true)
  expect(ForkPromptSuggestion.userEnabled()).toBe(true)
})

test("the Jev gate sends the last exchange and the open todo count, with a threshold from the environment", () => {
  const request = ForkPromptSuggestion.jevRequest({
    turns: [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "Done, the bug is fixed." },
    ],
    todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ],
  })
  expect(request.state).toContain("User's last message:\nfix the bug")
  expect(request.state).toContain("End of the agent's reply:\nDone, the bug is fixed.")
  expect(request.state).toContain("Open todos: 1.")
  expect(request.questions.predictable.type).toBe("noul")
  expect(ForkPromptSuggestion.jevMin({})).toBe(0.35)
  expect(ForkPromptSuggestion.jevMin({ OPENCODE_FORK_PROMPT_SUGGESTION_JEV_MIN: "0.6" })).toBe(0.6)
  expect(ForkPromptSuggestion.jevMin({ OPENCODE_FORK_PROMPT_SUGGESTION_JEV_MIN: "2" })).toBe(0.35)
})
