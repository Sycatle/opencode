import { ForkTelemetry } from "./telemetry"
import type { Signals, Tier } from "./route"

// Journal of Router decisions in fork.db. One "decision" row per user message (signals, tier, model,
// reason) and one "fallback" row each time a failed attempt moved the turn to another model.
// It is also the Router's memory across restarts: the last rows of a session give its tier history.

export type Entry = {
  time: number
  session_id: string
  // The user message the turn answers.
  message_id: string
  kind: "decision" | "fallback" | "escalation"
  mode: string
  tier: Tier
  provider_id: string
  model_id: string
  previous?: string
  reason: string
  score?: number
  signals?: Signals
  // Why the previous attempt was abandoned (fallback rows).
  error?: string
  // The reasoning effort variant the turn runs with, when the Router picked one.
  variant?: string
}

export type Row = Omit<Entry, "signals" | "previous" | "score" | "error" | "variant"> & {
  id: number
  previous: string | null
  score: number | null
  signals: string | null
  error: string | null
  variant: string | null
}

export function record(entry: Entry) {
  try {
    table()
      .query(
        `INSERT INTO fork_route (time, session_id, message_id, kind, mode, tier, provider_id, model_id, previous, reason, score, signals, error, variant)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.time,
        entry.session_id,
        entry.message_id,
        entry.kind,
        entry.mode,
        entry.tier,
        entry.provider_id,
        entry.model_id,
        entry.previous ?? null,
        entry.reason,
        entry.score ?? null,
        entry.signals ? JSON.stringify(entry.signals) : null,
        entry.error ?? null,
        entry.variant ?? null,
      )
  } catch {}
}

export function recent(limit: number, sessionID?: string) {
  return table()
    .query<Row, [string | null, string | null, number]>(
      "SELECT * FROM fork_route WHERE (? IS NULL OR session_id = ?) ORDER BY id DESC LIMIT ?",
    )
    .all(sessionID ?? null, sessionID ?? null, limit)
}

// Decisions of a session, newest first.
export function decisions(sessionID: string, limit: number) {
  return table()
    .query<Row, [string, number]>(
      "SELECT * FROM fork_route WHERE session_id = ? AND kind = 'decision' ORDER BY id DESC LIMIT ?",
    )
    .all(sessionID, limit)
}

// The latest row for a user message (decision or fallback): the model its turn is running on.
export function forMessage(sessionID: string, messageID: string) {
  return (
    table()
      .query<Row, [string, string]>(
        "SELECT * FROM fork_route WHERE session_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionID, messageID) ?? undefined
  )
}

// The latest row of a session, whatever its kind: the model the session is running on.
export function latest(sessionID: string) {
  return (
    table().query<Row, [string]>("SELECT * FROM fork_route WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionID) ??
    undefined
  )
}

export type Summary = { model: string; tier: string; turns: number; fallbacks: number }

// Per real model and tier: turns routed to it, and fallbacks that landed on it.
export function summary() {
  return table()
    .query<Summary, []>(
      `SELECT provider_id || '/' || model_id AS model, tier,
              SUM(kind = 'decision') AS turns, SUM(kind = 'fallback') AS fallbacks
       FROM fork_route GROUP BY provider_id, model_id, tier ORDER BY turns DESC`,
    )
    .all()
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_route (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    tier TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    previous TEXT,
    reason TEXT NOT NULL,
    score REAL,
    signals TEXT,
    error TEXT,
    variant TEXT
  )`)
  // Tables created before effort variants have no `variant` column.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(fork_route)").all()
  if (!columns.some((column) => column.name === "variant")) db.run("ALTER TABLE fork_route ADD variant TEXT")
  db.run("CREATE INDEX IF NOT EXISTS fork_route_session ON fork_route (session_id, id)")
  ready = true
  return db
}

export * as ForkRouteLog from "./route-log"
