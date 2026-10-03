import { ForkClassifier } from "@opencode-fork/core/classifier"

// Permission mode switching like Claude Code's shift+tab (see docs/fork/seams.md, `permission-mode`).
// A mode is an agent (build or plan) plus a stored mode in the session's permission ruleset.

type Rules = readonly ForkClassifier.Rule[] | undefined

export function current(rules: Rules, agent: string | undefined, draft: ForkClassifier.StoredMode) {
  return ForkClassifier.current(rules ? ForkClassifier.storedMode(rules) : draft, agent)
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
}) {
  const mode = ForkClassifier.next(current(input.rules, input.agent, input.draft))
  const stored: ForkClassifier.StoredMode = mode === "plan" ? "normal" : mode
  input.setAgent(mode === "plan" ? "plan" : !input.agent || input.agent === "plan" ? "build" : input.agent)
  if (!input.sessionID) {
    input.setDraft(stored)
    return mode
  }
  void input.save(ForkClassifier.withMode(input.rules, stored))
  return mode
}

export * as ForkPermissionMode from "./permission-mode"
