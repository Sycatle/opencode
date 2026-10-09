import { createSignal } from "solid-js"

// FORK-SEAM: permission-mode-web (shift+tab cycles build -> plan -> auto, like the TUI)
//
// Mirrors packages/fork/src/classifier.ts (storedMode, withMode, current, next) and
// packages/tui/src/feature-plugins/fork/permission-mode.ts, which cannot be imported here: they pull bun:sqlite.
// A mode is an agent (build or plan) plus a marker rule in `session.permission` that the server's classifier reads.

export const MODE_PERMISSION = "fork.mode"

export type Mode = "normal" | "plan" | "auto"
export type StoredMode = "normal" | "auto"
export type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

const CYCLE: readonly Mode[] = ["normal", "plan", "auto"]

// The mode of a session that does not exist yet, applied when it is created.
const [draft, setDraft] = createSignal<StoredMode>("normal")
export const draftMode = draft
export const resetDraftMode = () => setDraft("normal")

// The mode just picked, until the server confirms it: the ruleset only changes once the update comes back,
// so without this a second key press would start from the old mode.
const [pending, setPending] = createSignal<{ sessionID: string; stored: StoredMode } | undefined>()

export function storedMode(rules: readonly Rule[] | undefined): StoredMode | undefined {
  const marker = rules?.findLast((rule) => rule.permission === MODE_PERMISSION)?.pattern
  if (marker === "acceptEdits") return "normal"
  return marker === "auto" || marker === "normal" ? marker : undefined
}

export function withMode<T extends Rule>(rules: readonly T[] | undefined, mode: StoredMode): (T | Rule)[] {
  const rest = (rules ?? []).filter((rule) => rule.permission !== MODE_PERMISSION)
  return mode === "normal" ? rest : [...rest, { permission: MODE_PERMISSION, pattern: mode, action: "allow" }]
}

// `session.update` appends the rules it receives (the last marker wins) instead of replacing the stored ones:
// send only this marker, "normal" included, never the whole ruleset.
export function modeRule(mode: StoredMode): Rule {
  return { permission: MODE_PERMISSION, pattern: mode, action: "allow" }
}

// Plan is an agent, not a stored mode: a stored mode wins, otherwise the plan agent means plan.
export function resolve(stored: StoredMode | undefined, agent: string | undefined): Mode {
  if (agent === "plan") return "plan"
  return stored ?? "normal"
}

export function next(mode: Mode): Mode {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
}

// "normal" is shown as build: users never see the internal name.
export function label(mode: Mode) {
  return mode === "normal" ? "build" : mode
}

// Undefined sessionID: the new session screen, where the mode is the draft.
export function current(sessionID: string | undefined, rules: readonly Rule[] | undefined, agent: string | undefined) {
  if (!sessionID) return resolve(draft(), agent)
  const optimistic = pending()?.sessionID === sessionID ? pending()!.stored : undefined
  return resolve(optimistic ?? storedMode(rules), agent)
}

export function cycle(input: {
  sessionID: string | undefined
  rules: readonly Rule[] | undefined
  agent: string | undefined
  setAgent: (name: string) => void
  save: (rules: Rule[]) => Promise<unknown>
  onError: (error: unknown) => void
}) {
  const mode = next(current(input.sessionID, input.rules, input.agent))
  const stored: StoredMode = mode === "plan" ? "normal" : mode
  input.setAgent(mode === "plan" ? "plan" : !input.agent || input.agent === "plan" ? "build" : input.agent)
  const sessionID = input.sessionID
  if (!sessionID) {
    setDraft(stored)
    return mode
  }
  const clear = () => setPending((value) => (value?.sessionID === sessionID ? undefined : value))
  setPending({ sessionID, stored })
  const fail = (error: unknown) => {
    clear()
    input.onError(error)
  }
  input
    .save([modeRule(stored)])
    .then(() => {
      // Keep the optimistic value a moment longer: the confirmation reaches the screen through an event.
      setTimeout(clear, 3000)
    })
    .catch(fail)
  return mode
}

export * as ForkMode from "./fork-mode"
