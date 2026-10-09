import { ForkClassifier } from "@opencode-fork/core/classifier"
import { createSignal } from "solid-js"

// Permission mode switching like Claude Code's shift+tab (see docs/fork/seams.md, `permission-mode`).
// A mode is an agent (build or plan) plus a stored mode in the session's permission ruleset.

type Rules = readonly ForkClassifier.Rule[] | undefined

// The mode just picked, until the server confirms it. The ruleset the screen reads only changes once the
// update comes back, so without this a second key press would start from the old mode and look stuck.
const [pending, setPending] = createSignal<{ sessionID: string; stored: ForkClassifier.StoredMode } | undefined>()

export function current(
  sessionID: string | undefined,
  rules: Rules,
  agent: string | undefined,
  draft: ForkClassifier.StoredMode,
) {
  const optimistic = sessionID && pending()?.sessionID === sessionID ? pending()!.stored : undefined
  return ForkClassifier.current(optimistic ?? (rules ? ForkClassifier.storedMode(rules) : draft), agent)
}

export function cycle(input: {
  // Undefined on the home screen: the new mode is kept as the draft for the session created next.
  sessionID: string | undefined
  rules: Rules
  agent: string | undefined
  draft: ForkClassifier.StoredMode
  setAgent: (name: string) => void
  setDraft: (mode: ForkClassifier.StoredMode) => void
  save: (rules: ForkClassifier.Rule[]) => Promise<unknown>
  onError: (error: unknown) => void
}) {
  const mode = ForkClassifier.next(current(input.sessionID, input.rules, input.agent, input.draft))
  const stored: ForkClassifier.StoredMode = mode === "plan" ? "normal" : mode
  input.setAgent(mode === "plan" ? "plan" : !input.agent || input.agent === "plan" ? "build" : input.agent)
  if (!input.sessionID) {
    input.setDraft(stored)
    return mode
  }
  const sessionID = input.sessionID
  const clear = () => setPending((value) => (value?.sessionID === sessionID ? undefined : value))
  setPending({ sessionID, stored })
  const fail = (error: unknown) => {
    clear()
    input.onError(error)
  }
  input
    .save([ForkClassifier.modeRule(stored)])
    .then((result) => {
      const error = (result as { error?: unknown } | undefined)?.error
      if (error) return fail(error)
      // Keep the optimistic value a moment longer: the confirmation reaches the screen through an event.
      setTimeout(clear, 3000)
    })
    .catch(fail)
  return mode
}

export * as ForkPermissionMode from "./permission-mode"
