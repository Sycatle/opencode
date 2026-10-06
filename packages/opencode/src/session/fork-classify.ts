import { ForkClassifier } from "@opencode-fork/core/classifier"
import { Effect } from "effect"
import type { Permission } from "@/permission"
import type { SessionID } from "./schema"
import { Session } from "./session"

type AskInput = Parameters<Permission.Interface["ask"]>[0]

export type Judgement = { action: "allow" } | { action: "ask"; reason?: string }

// Runs inside the project's instance (see ForkPermission) to inherit Auto from a parent session.
export const judge = Effect.fn("ForkClassify.judge")(function* (input: AskInput) {
  const mode = yield* sessionMode(input.sessionID, input.ruleset)
  if (mode === "auto") return { action: "allow" } satisfies Judgement
  return { action: "ask" } satisfies Judgement
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
