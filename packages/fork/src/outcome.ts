import { ForkRouteLog } from "./route-log"
import { ForkTelemetry } from "./telemetry"

// Journal of how turns ended badly, in fork.db: the user interrupted the turn ("aborted"), the provider or a
// tool failed it ("error"), or the user reverted it ("reverted"). Keyed by the user message the turn answers,
// like fork_route, so a Router decision can be judged by what happened to its turn.

export type Kind = "aborted" | "error" | "reverted"

export function record(entry: { session_id: string; message_id: string; kind: Kind; detail?: string }) {
  try {
    table()
      .query("INSERT INTO fork_outcome (time, session_id, message_id, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), entry.session_id, entry.message_id, entry.kind, entry.detail ?? null)
  } catch {}
}

export type ByModel = {
  tier: string
  model: string
  turns: number
  aborted: number
  error: number
  reverted: number
  escalated: number
}

// Per tier and model the Router picked: turns, and how many of them were interrupted, failed, reverted or
// escalated to a stronger tier. A high share on a cheap tier means the Router routes too low.
export function byModel() {
  // The report joins fork_route, which may not exist yet.
  ForkRouteLog.table()
  return table()
    .query<ByModel, []>(
      `SELECT r.tier, r.provider_id || '/' || r.model_id AS model, COUNT(*) AS turns,
              SUM(EXISTS (SELECT 1 FROM fork_outcome o WHERE o.session_id = r.session_id AND o.message_id = r.message_id AND o.kind = 'aborted')) AS aborted,
              SUM(EXISTS (SELECT 1 FROM fork_outcome o WHERE o.session_id = r.session_id AND o.message_id = r.message_id AND o.kind = 'error')) AS error,
              SUM(EXISTS (SELECT 1 FROM fork_outcome o WHERE o.session_id = r.session_id AND o.message_id = r.message_id AND o.kind = 'reverted')) AS reverted,
              SUM(EXISTS (SELECT 1 FROM fork_route e WHERE e.session_id = r.session_id AND e.message_id = r.message_id AND e.kind = 'escalation')) AS escalated
       FROM fork_route r WHERE r.kind = 'decision'
       GROUP BY r.tier, r.provider_id, r.model_id ORDER BY turns DESC`,
    )
    .all()
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_outcome (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
  )`)
  db.run("CREATE INDEX IF NOT EXISTS fork_outcome_message ON fork_outcome (session_id, message_id)")
  ready = true
  return db
}

export * as ForkOutcome from "./outcome"
