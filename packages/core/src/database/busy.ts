import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type { SqlError } from "effect/unstable/sql/SqlError"

const SLOW_MS = 1000

// Several opencode processes share one SQLite file and WAL allows a single writer. When another process holds the
// write lock longer than busy_timeout, the statement fails with `database is locked`. That is transient, so retry it
// (sleeping asynchronously, unlike the synchronous busy handler) instead of failing the user's turn.
export const retryBusy = <A>(query: string, effect: Effect.Effect<A, SqlError>) =>
  Effect.suspend(() => {
    const start = Date.now()
    return effect.pipe(
      Effect.tapError((error) =>
        error.reason._tag === "LockTimeoutError"
          ? Effect.logWarning("sqlite database locked", { query: summarize(query), waited: Date.now() - start })
          : Effect.void,
      ),
      Effect.retry({
        schedule: Schedule.exponential("250 millis"),
        times: 3,
        while: (error) => error.reason._tag === "LockTimeoutError",
      }),
      Effect.tap(() => {
        const elapsed = Date.now() - start
        return elapsed < SLOW_MS
          ? Effect.void
          : Effect.logWarning("slow sqlite statement", { query: summarize(query), elapsed })
      }),
    )
  })

// Parameters are never logged: they can hold prompt and tool output content.
function summarize(query: string) {
  return query.replace(/\s+/g, " ").slice(0, 80)
}
