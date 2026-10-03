// FORK-SEAM: messaging
export * as ForkSessionMessaging from "./fork-messaging"
import { Effect, Scope } from "effect"
import { ForkMessaging } from "@opencode-fork/core/messaging"
import { ForkWakeup } from "@opencode-fork/core/wakeup"
import type { SessionID } from "./schema"

type Deps = {
  scope: Scope.Scope
  prompt: (input: {
    sessionID: SessionID
    agent?: string
    parts: { type: "text"; synthetic: true; text: string }[]
  }) => Effect.Effect<unknown, unknown>
  title: (sessionID: SessionID) => Effect.Effect<{ title: string; parentID?: string }, unknown>
  busy: (sessionID: SessionID) => Effect.Effect<boolean>
}

type Info = { sessionID: SessionID; cwd: string; agent: string; title: string; parentID?: string }
// Registers the sessions of this process in fork_agents and delivers their mailbox. One watcher per process
// heartbeats every known session and, every poll, turns pending messages into a synthetic user message through
// the same `prompt` path as background job notifications: a busy session picks it up at its next turn, an idle
// one is woken. The session keeps its own agent, so plan mode and permissions are unchanged. The same watcher
// delivers the session's scheduled wakeup (see ForkWakeup) once it is due and the session is idle.
export function make(deps: Deps) {
  const latest = new Map<string, Info>()
  // Last registration per session: the heartbeat in the watcher, the activity in `touch`.
  const beats = new Map<string, number>()
  const active = new Map<string, number>()
  let watching = false

  const deliver = Effect.fn("ForkMessaging.deliver")(function* (info: Info) {
    if (ForkMessaging.enabled() && Date.now() - (beats.get(info.sessionID) ?? 0) >= ForkMessaging.BEAT_MS) {
      // A deleted session stops being watched instead of failing at every poll.
      const session = yield* deps.title(info.sessionID).pipe(Effect.option)
      if (session._tag === "None") return yield* Effect.sync(() => drop(info.sessionID))
      beats.set(info.sessionID, Date.now())
      ForkMessaging.register({
        sessionID: info.sessionID,
        cwd: info.cwd,
        agent: info.agent,
        title: session.value.title,
        kind: ForkMessaging.kindFromArgv(process.argv, session.value.parentID),
      })
    }
    const texts = (ForkMessaging.enabled() ? ForkMessaging.claim(info.sessionID) : []).map((item) =>
      ForkMessaging.render({
        from: item.from_name,
        sessionID: item.from_session,
        summary: item.summary,
        message: item.message,
      }),
    )
    // A wakeup waits for the end of the current turn; a message does not, it joins the next step.
    const wakeup =
      ForkWakeup.enabled() && !(yield* deps.busy(info.sessionID)) ? ForkWakeup.claimDue(info.sessionID) : undefined
    if (wakeup) texts.push(ForkWakeup.render(wakeup))
    if (!texts.length) return
    yield* deps
      .prompt({
        sessionID: info.sessionID,
        agent: info.agent,
        parts: texts.map((text) => ({ type: "text" as const, synthetic: true as const, text })),
      })
      .pipe(Effect.ignore, Effect.forkIn(deps.scope, { startImmediately: true }))
  })

  const drop = (sessionID: string) => {
    latest.delete(sessionID)
    beats.delete(sessionID)
    active.delete(sessionID)
    if (ForkMessaging.enabled()) ForkMessaging.leave(sessionID)
  }

  const watch = Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(`${ForkMessaging.pollMs()} millis`)
      for (const info of [...latest.values()]) yield* deliver(info).pipe(Effect.catchCause(() => Effect.void))
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => [...latest.keys()].forEach(drop))))

  // Called at every step of a session loop. The registration refreshes the activity at most once per heartbeat:
  // it scans fork_agents, so running it at every step would cost a write transaction per step.
  const touch = Effect.fn("ForkMessaging.touch")(function* (info: Info) {
    if (!ForkMessaging.enabled() && !ForkWakeup.enabled()) return
    latest.set(info.sessionID, info)
    const now = Date.now()
    if (ForkMessaging.enabled() && now - (active.get(info.sessionID) ?? 0) >= ForkMessaging.BEAT_MS) {
      active.set(info.sessionID, now)
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
    }
    if (watching) return
    watching = true
    yield* watch.pipe(Effect.forkIn(deps.scope))
  })

  return { touch }
}
