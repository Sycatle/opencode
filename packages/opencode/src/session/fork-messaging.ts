// FORK-SEAM: messaging
export * as ForkSessionMessaging from "./fork-messaging"
import { Effect, Scope } from "effect"
import { ForkMessaging } from "@opencode-fork/core/messaging"
import type { SessionID } from "./schema"

type Deps = {
  scope: Scope.Scope
  prompt: (input: {
    sessionID: SessionID
    agent?: string
    parts: { type: "text"; synthetic: true; text: string }[]
  }) => Effect.Effect<unknown, unknown>
  title: (sessionID: SessionID) => Effect.Effect<{ title: string; parentID?: string }, unknown>
}

type Info = { sessionID: SessionID; cwd: string; agent: string; title: string; parentID?: string }

// Registers the sessions of this process in fork_agents and delivers their mailbox. Each session gets a
// watcher that heartbeats and, every poll, turns pending messages into a synthetic user message through the
// same `prompt` path as background job notifications: a busy session picks it up at its next turn, an idle
// one is woken. The session keeps its own agent, so plan mode and permissions are unchanged.
export function make(deps: Deps) {
  const latest = new Map<string, Info>()

  const watch = Effect.fn("ForkMessaging.watch")(function* (sessionID: SessionID) {
    let beat = 0
    let titled = ""
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(`${ForkMessaging.pollMs()} millis`)
        const info = latest.get(sessionID)
        if (!info) return
        const session = yield* deps.title(sessionID)
        if (Date.now() - beat >= ForkMessaging.BEAT_MS || session.title !== titled) {
          beat = Date.now()
          titled = session.title
          ForkMessaging.register({
            sessionID,
            cwd: info.cwd,
            agent: info.agent,
            title: session.title,
            kind: ForkMessaging.kindFromArgv(process.argv, session.parentID),
          })
        }
        const messages = ForkMessaging.claim(sessionID)
        if (!messages.length) return
        yield* deps
          .prompt({
            sessionID,
            agent: info.agent,
            parts: messages.map((item) => ({
              type: "text" as const,
              synthetic: true as const,
              text: ForkMessaging.render({
                from: item.from_name,
                sessionID: item.from_session,
                summary: item.summary,
                message: item.message,
              }),
            })),
          })
          .pipe(Effect.ignore, Effect.forkIn(deps.scope, { startImmediately: true }))
      }).pipe(Effect.catchCause(() => Effect.void)),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          latest.delete(sessionID)
          ForkMessaging.leave(sessionID)
        }),
      ),
    )
  })

  // Called at every step of a session loop.
  const touch = Effect.fn("ForkMessaging.touch")(function* (info: Info) {
    if (!ForkMessaging.enabled()) return
    const first = !latest.has(info.sessionID)
    latest.set(info.sessionID, info)
    yield* Effect.sync(() =>
      ForkMessaging.register({
        sessionID: info.sessionID,
        cwd: info.cwd,
        agent: info.agent,
        title: info.title,
        kind: ForkMessaging.kindFromArgv(process.argv, info.parentID),
        active: true,
      }),
    ).pipe(Effect.catchCause(() => Effect.void))
    if (first) yield* watch(info.sessionID).pipe(Effect.forkIn(deps.scope))
  })

  return { touch }
}
