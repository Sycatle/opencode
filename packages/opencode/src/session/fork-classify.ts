import { ForkClassifier } from "@opencode-fork/core/classifier"
import { Effect } from "effect"
import type { Permission } from "@/permission"
import type { SessionID } from "./schema"
import { Session } from "./session"
import { smallModelRun } from "./fork-small-model"

type AskInput = Parameters<Permission.Interface["ask"]>[0]

export type Judgement = { action: "allow" } | { action: "ask"; reason?: string }

// Runs inside the project's instance (see ForkPermission): resolves the session's permission mode, then
// approves accepted edits or lets the small model judge in auto mode. "ask" means a real request to the user.
export const judge = Effect.fn("ForkClassify.judge")(function* (input: AskInput) {
  if (ForkClassifier.neverAuto(input.permission)) return { action: "ask" } satisfies Judgement
  const mode = yield* sessionMode(input.sessionID, input.ruleset)
  if (ForkClassifier.acceptsEdit(mode, input.permission)) return { action: "allow" } satisfies Judgement
  if (mode !== "auto" || !ForkClassifier.enabled()) return { action: "ask" } satisfies Judgement
  const verdict = yield* classify(input)
  if (verdict.decision === "allow") return { action: "allow" } satisfies Judgement
  return { action: "ask", reason: verdict.reason } satisfies Judgement
})

// The marker lives in the session ruleset; sub-agent sessions inherit the nearest parent's mode.
const sessionMode = Effect.fn("ForkClassify.mode")(function* (sessionID: SessionID, ruleset: AskInput["ruleset"]) {
  const own = ForkClassifier.storedMode(ruleset)
  if (own) return own
  const sessions = yield* Session.Service
  const find = (id: SessionID, depth: number): Effect.Effect<ForkClassifier.StoredMode | undefined> =>
    Effect.gen(function* () {
      const session = yield* sessions.get(id).pipe(Effect.option)
      if (session._tag === "None") return undefined
      const stored = ForkClassifier.storedMode(session.value.permission)
      if (stored || !session.value.parentID || depth <= 0) return stored
      return yield* find(session.value.parentID, depth - 1)
    })
  return yield* find(sessionID, 4)
})

// Never fails: an error, an unreadable answer or a timeout is a "deny" whose reason is shown to the user.
const classify = Effect.fn("ForkClassify.classify")(function* (input: AskInput) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(input.sessionID).pipe(Effect.option)
  const messages = yield* sessions
    .messages({ sessionID: input.sessionID, limit: 12 })
    .pipe(Effect.orElseSucceed(() => []))
  const lines = messages.flatMap((message) => {
    const text = message.parts
      .flatMap((part) => {
        if (part.type === "text") return part.synthetic ? [] : [part.text]
        if (part.type === "tool") return [`[tool ${part.tool} ${JSON.stringify(part.state.input)}]`]
        return []
      })
      .join("\n")
    return text ? [{ role: message.info.role, text }] : []
  })
  const lastUser = messages.findLast((message) => message.info.role === "user")
  const action = { permission: input.permission, patterns: input.patterns, metadata: input.metadata }

  const exit = yield* smallModelRun({
    prompt: ForkClassifier.prompt({
      action,
      directory: session._tag === "Some" ? session.value.directory : undefined,
      lastUser: lastUser?.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n"),
      transcript: lines,
    }),
    current:
      lastUser?.info.role === "user"
        ? { providerID: lastUser.info.model.providerID, modelID: lastUser.info.model.modelID }
        : undefined,
  }).pipe(Effect.timeoutOption(ForkClassifier.TIMEOUT_MS), Effect.exit)

  const settled = (
    decision: ForkClassifier.Entry["decision"],
    reason: string,
    model?: { cost: number; providerID: string; modelID: string },
  ) => {
    ForkClassifier.record({ sessionID: input.sessionID, ...action, decision, reason, cost: model?.cost ?? 0, ...model })
    return { decision: decision === "allow" ? ("allow" as const) : ("deny" as const), reason }
  }

  if (exit._tag === "Failure") return settled("error", `Classifier unavailable: ${String(exit.cause).slice(0, 200)}`)
  if (exit.value._tag === "None")
    return settled("timeout", `Classifier timed out after ${ForkClassifier.TIMEOUT_MS / 1000}s`)
  const verdict = ForkClassifier.parse(exit.value.value.text)
  if (!verdict) return settled("error", "Classifier gave an unreadable answer", exit.value.value)
  return settled(verdict.decision, verdict.reason, exit.value.value)
})
