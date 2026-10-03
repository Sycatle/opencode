import { ForkJev } from "@opencode-fork/core/jev"
import { ForkPromptSuggestion } from "@opencode-fork/core/prompt-suggestion"
import { Effect } from "effect"
import type { SessionID } from "./schema"
import { Session } from "./session"
import { smallModelRun } from "./fork-small-model"

// Runs when the loop of a session ends (see the `prompt-suggestion` seam in prompt.ts), forked so it never
// delays the turn. Asks the small model for the user's likely next request and stores it in fork.db for the TUI.
// Never fails: a missing small model, an error or a timeout just means no suggestion.
export const suggest = Effect.fn("ForkSuggest.suggest")(function* (sessionID: SessionID) {
  if (!ForkPromptSuggestion.interactive() || !ForkPromptSuggestion.enabled() || !ForkPromptSuggestion.userEnabled()) return
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const messages = yield* sessions.messages({ sessionID, limit: 30 })
  const last = messages.at(-1)
  const lastUser = messages.findLast((message) => message.info.role === "user")
  if (!last || last.info.role !== "assistant" || lastUser?.info.role !== "user") return

  const turns = messages.flatMap((message) => {
    const text = message.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("\n")
    return text ? [{ role: message.info.role, text }] : []
  })
  const reason = ForkPromptSuggestion.skip({
    enabled: true,
    parentID: session.parentID,
    agent: lastUser.info.agent,
    last: {
      role: "assistant",
      finish: last.info.finish,
      error: !!last.info.error,
      summary: !!last.info.summary,
    },
    pendingQuestion: last.parts.some(
      (part) => part.type === "tool" && part.tool === "question" && part.state.status !== "completed",
    ),
    text: last.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  })
  if (reason) return

  const todoPart = messages
    .flatMap((message) => message.parts)
    .findLast((part) => part.type === "tool" && part.tool === "todowrite" && part.state.status === "completed")
  const todos =
    todoPart?.type === "tool" && Array.isArray(todoPart.state.input.todos)
      ? todoPart.state.input.todos.flatMap((todo: unknown) =>
          typeof todo === "object" && todo && "content" in todo && "status" in todo
            ? [{ content: String(todo.content), status: String(todo.status) }]
            : [],
        )
      : []

  // Jev first: a follow-up that cannot be guessed is not worth a small-model call. Any failure, and shadow
  // mode, go on to the small model as before.
  const jev = ForkJev.mode("PROMPT_SUGGESTION")
  if (jev !== "off") {
    const answer = yield* Effect.promise(() => ForkJev.ask(ForkPromptSuggestion.jevRequest({ turns, todos })))
    const noul = answer.answers?.predictable?.noul
    const skipped = noul !== undefined && noul < ForkPromptSuggestion.jevMin()
    ForkJev.journal({
      feature: "prompt_suggestion",
      session_id: sessionID,
      ms: answer.ms,
      ok: noul !== undefined,
      error: answer.error ?? (noul === undefined ? "Jev response unusable" : undefined),
      decision: noul === undefined ? undefined : skipped ? "skip" : "ask",
      other: jev === "shadow" ? "ask" : undefined,
      answers: answer.answers,
    })
    if (skipped && jev === "on") return
  }
  const exit = yield* smallModelRun({
    prompt: ForkPromptSuggestion.prompt({ turns, todos }),
    maxOutputTokens: ForkPromptSuggestion.MAX_OUTPUT_TOKENS,
    noThinking: true,
    current: { providerID: lastUser.info.model.providerID, modelID: lastUser.info.model.modelID },
  }).pipe(Effect.timeoutOption(ForkPromptSuggestion.TIMEOUT_MS), Effect.exit)
  if (exit._tag === "Failure" || exit.value._tag === "None") return

  // The user may have sent something while the small model was answering: that suggestion is stale.
  const now = yield* sessions.messages({ sessionID, limit: 1 })
  const fresh = now.at(0)?.info.id === last.info.id
  ForkPromptSuggestion.record({
    sessionID,
    messageID: last.info.id,
    text: fresh ? ForkPromptSuggestion.clean(exit.value.value.text) : undefined,
    cost: exit.value.value.cost,
    providerID: exit.value.value.providerID,
    modelID: exit.value.value.modelID,
  })
})

export * as ForkSuggest from "./fork-suggest"
