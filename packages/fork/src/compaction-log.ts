import { ForkTelemetry } from "./telemetry"
import type { Phase, Decision } from "./compaction-timing"

// Journal of smart compaction decisions in fork.db: one row each time the policy ran at the end
// of a turn or at the start of a cold one, whether it compacted or not, and why.

export type Row = {
  id: number
  time: number
  session_id: string
  message_id: string
  phase: Phase
  compact: number
  code: string
  reason: string
  cold: number
  context: number
  window: number
  threshold: number
  cost: number
  benefit: number
}

export function record(input: { sessionID: string; messageID: string; phase: Phase; decision: Decision }) {
  const decision = input.decision
  // The journal must never break a session turn.
  try {
    table()
      .query(
        `INSERT INTO fork_compaction (time, session_id, message_id, phase, compact, code, reason, cold, context, window, threshold, cost, benefit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        input.sessionID,
        input.messageID,
        input.phase,
        decision.compact ? 1 : 0,
        decision.code,
        decision.reason,
        decision.cold ? 1 : 0,
        decision.context,
        decision.window,
        decision.threshold,
        decision.cost,
        decision.benefit,
      )
  } catch {}
}

// Oldest first.
export function list(sessionID: string, limit = 200) {
  return table()
    .query<Row, [string, number]>(
      "SELECT * FROM (SELECT * FROM fork_compaction WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
    )
    .all(sessionID, limit)
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_compaction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    compact INTEGER NOT NULL,
    code TEXT NOT NULL,
    reason TEXT NOT NULL,
    cold INTEGER NOT NULL,
    context INTEGER NOT NULL,
    window INTEGER NOT NULL,
    threshold REAL NOT NULL,
    cost REAL NOT NULL,
    benefit REAL NOT NULL
  )`)
  db.run("CREATE INDEX IF NOT EXISTS fork_compaction_session ON fork_compaction (session_id, id)")
  ready = true
  return db
}

export * as ForkCompactionLog from "./compaction-log"
