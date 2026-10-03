import { ForkPromptSuggestion } from "@opencode-fork/core/prompt-suggestion"
import { createSignal, onCleanup } from "solid-js"

// Grey suggestion in the empty prompt, accepted with Tab (see docs/fork/seams.md, `prompt-suggestion`). The
// server writes it to fork.db when a turn ends; like the usage widgets this only works when the TUI runs on
// the machine of the server.

const REFRESH_MS = 1000

// The suggestion that may be shown now, or undefined. It belongs to the last assistant message of the session
// (so a new turn or a new user message retires it) and only shows while the field is empty.
export function visible(input: {
  row: Pick<ForkPromptSuggestion.Row, "message_id" | "text"> | null | undefined
  lastMessage: { id: string; role: string } | undefined
  prompt: string
  enabled: boolean
}) {
  if (!input.enabled || !input.row?.text) return undefined
  if (input.prompt !== "") return undefined
  if (input.lastMessage?.role !== "assistant" || input.lastMessage.id !== input.row.message_id) return undefined
  return input.row.text
}

export function createSuggestions(sessionID: () => string | undefined) {
  const [row, setRow] = createSignal<ForkPromptSuggestion.Row | null>(null)
  const [enabled, setEnabled] = createSignal(ForkPromptSuggestion.enabled() && ForkPromptSuggestion.userEnabled())
  const refresh = () => {
    setEnabled(ForkPromptSuggestion.enabled() && ForkPromptSuggestion.userEnabled())
    const id = sessionID()
    setRow(id && enabled() ? ForkPromptSuggestion.latest(id) : null)
  }
  refresh()
  const timer = setInterval(refresh, REFRESH_MS)
  onCleanup(() => clearInterval(timer))
  return {
    row,
    enabled,
    toggle() {
      ForkPromptSuggestion.setUserEnabled(!ForkPromptSuggestion.userEnabled())
      refresh()
    },
  }
}

export * as ForkPromptSuggest from "./prompt-suggestion"
