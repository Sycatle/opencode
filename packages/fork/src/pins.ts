import { ForkTelemetry } from "./telemetry"

// Messages the user pinned: their text is copied verbatim into every compaction
// summary of the session, so it is never paraphrased or dropped.

const MAX_PIN_CHARS = 4000

export type Pin = { message_id: string; text: string; time: number }

export function toggle(sessionID: string, messageID: string, text: string) {
  const existing = table()
    .query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM fork_pins WHERE session_id = ? AND message_id = ?")
    .get(sessionID, messageID)
  if (existing?.n) {
    table().query("DELETE FROM fork_pins WHERE session_id = ? AND message_id = ?").run(sessionID, messageID)
    return false
  }
  table()
    .query("INSERT INTO fork_pins (session_id, message_id, text, time) VALUES (?, ?, ?, ?)")
    .run(sessionID, messageID, text.slice(0, MAX_PIN_CHARS), Date.now())
  return true
}

export function list(sessionID: string) {
  return table()
    .query<Pin, [string]>("SELECT message_id, text, time FROM fork_pins WHERE session_id = ? ORDER BY time")
    .all(sessionID)
}

export function format(pins: readonly Pin[]) {
  if (!pins.length) return undefined
  return ["## Pinned (verbatim)", ...pins.map((pin) => `- ${pin.text.replaceAll("\n", "\n  ")}`)].join("\n")
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_pins (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    time INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id)
  )`)
  ready = true
  return db
}

export * as ForkPins from "./pins"
