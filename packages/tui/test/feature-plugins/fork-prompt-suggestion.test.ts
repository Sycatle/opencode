import { expect, test } from "bun:test"
import { resolve } from "../../src/config"
import { ForkPromptSuggest } from "../../src/feature-plugins/fork/prompt-suggestion"

const row = { message_id: "msg_2", text: "run the e2e tests" }
const last = { id: "msg_2", role: "assistant" }
const show = (over: Partial<Parameters<typeof ForkPromptSuggest.visible>[0]> = {}) =>
  ForkPromptSuggest.visible({ row, lastMessage: last, prompt: "", enabled: true, ...over })

test("shows the suggestion of the last assistant message in an empty prompt", () => {
  expect(show()).toBe("run the e2e tests")
})

test("hides it once the user types, on a newer message, when empty or disabled", () => {
  expect(show({ prompt: "r" })).toBeUndefined()
  expect(show({ lastMessage: { id: "msg_3", role: "user" } })).toBeUndefined()
  expect(show({ lastMessage: { id: "msg_3", role: "assistant" } })).toBeUndefined()
  expect(show({ lastMessage: undefined })).toBeUndefined()
  expect(show({ row: { message_id: "msg_2", text: null } })).toBeUndefined()
  expect(show({ row: undefined })).toBeUndefined()
  expect(show({ enabled: false })).toBeUndefined()
})

test("tab accepts the suggestion, shift+tab cycles the mode and agents moved to a free key", () => {
  const keybinds = resolve({}, { terminalSuspend: true }).keybinds
  expect(keybinds.get("prompt.suggestion.accept")).toMatchObject([{ key: "tab" }])
  expect(keybinds.get("permission.mode.cycle")).toMatchObject([{ key: "shift+tab" }])
  expect(keybinds.get("agent.cycle")).toMatchObject([{ key: "f3" }])
  expect(keybinds.get("agent.cycle.reverse")).toMatchObject([{ key: "shift+f3" }])
})

test("the accept key and the agent key can be rebound", () => {
  const keybinds = resolve(
    { keybinds: { prompt_suggestion_accept: "ctrl+y", agent_cycle: "tab" } },
    { terminalSuspend: true },
  ).keybinds
  expect(keybinds.get("prompt.suggestion.accept")).toMatchObject([{ key: "ctrl+y" }])
  expect(keybinds.get("agent.cycle")).toMatchObject([{ key: "tab" }])
})
