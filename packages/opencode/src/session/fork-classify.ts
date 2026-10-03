import { ForkClassifier } from "@opencode-fork/core/classifier"
import { ForkGuard } from "@opencode-fork/core/guard"
import { ForkJev } from "@opencode-fork/core/jev"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import type { Permission } from "@/permission"
import type { SessionID } from "./schema"
import { Session } from "./session"
import { smallModelRun } from "./fork-small-model"

type AskInput = Parameters<Permission.Interface["ask"]>[0]

export type Judgement = { action: "allow" } | { action: "ask"; reason?: string }

// Approvals already given in a session, by permission and patterns: the same action asked again within
// CACHE_MS is approved without another classifier round trip. Denials are not kept, they reach the user anyway.
const approved = new Map<string, number>()
const CACHE_MS = 10 * 60_000
const MAX_CACHED = 500

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
  const action = { permission: input.permission, patterns: input.patterns, metadata: input.metadata }
  const key = `${input.sessionID}\0${input.permission}\0${JSON.stringify(input.patterns)}`
  const now = Date.now()
  for (const [id, time] of approved) if (now - time > CACHE_MS) approved.delete(id)
  // Output that looked like an injection voids earlier approvals: the action may now come from it.
  if (approved.has(key) && !ForkGuard.recent(input.sessionID)) {
    const reason = "Same action approved earlier in this session"
    ForkClassifier.record({ sessionID: input.sessionID, ...action, decision: "allow", reason, cost: 0, source: "cache" })
    return { decision: "allow" as const, reason }
  }
  const verdict = yield* judgeAction(input, action)
  if (verdict.decision === "allow" && approved.size < MAX_CACHED) approved.set(key, now)
  return verdict
})

const judgeAction = Effect.fn("ForkClassify.judgeAction")(function* (
  input: AskInput,
  action: { permission: string; patterns: readonly string[]; metadata: AskInput["metadata"] },
) {
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

  // Jev first. A confident danger or a confident, requested, in-scope action settles the request here; anything
  // else, a failure and the shadow mode go on to the small model. An approval never comes from Jev alone when
  // the session recently read tool output that looked like an injection.
  const jev = ForkJev.mode("AUTO_CLASSIFIER")
  if (jev !== "off") {
    const answer = yield* Effect.promise((signal) =>
      ForkJev.ask({
        ...ForkClassifier.jevRequest({
          action,
          directory: session._tag === "Some" ? session.value.directory : undefined,
          home: Global.Path.home,
          lastUser: lastUser?.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n"),
        }),
        signal,
      }),
    )
    const verdict = ForkClassifier.jevVerdict(answer.answers, ForkGuard.recent(input.sessionID))
    ForkJev.journal({
      feature: "auto_classifier",
      session_id: input.sessionID,
      ms: answer.ms,
      ok: answer.answers !== undefined,
      error: answer.error,
      decision: verdict?.decision ?? "small-model",
      answers: answer.answers,
    })
    if (verdict && jev === "on") {
      const decision = verdict.decision === "allow" ? ("allow" as const) : ("deny" as const)
      ForkClassifier.record({
        sessionID: input.sessionID,
        ...action,
        decision,
        reason: verdict.reason,
        cost: 0,
        providerID: "typesafe",
        modelID: ForkJev.model(),
        source: "jev",
        ms: answer.ms,
      })
      return { decision, reason: verdict.reason }
    }
  }

  const exit = yield* smallModelRun({
    prompt: ForkClassifier.prompt({
      action,
      directory: session._tag === "Some" ? session.value.directory : undefined,
      lastUser: lastUser?.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n"),
      transcript: lines,
    }),
    // The answer is a one-line JSON verdict: no thinking, and never the session's main (possibly Opus) model.
    noThinking: true,
    maxOutputTokens: 300,
    smallOnly: true,
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
