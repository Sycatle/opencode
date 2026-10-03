import type { ForkJev } from "./jev"
import { ForkTelemetry } from "./telemetry"

// Messages the user pinned: their text is copied verbatim into every compaction
// summary of the session, so it is never paraphrased or dropped.

const MAX_PIN_CHARS = 4000

export type Pin = { message_id: string; text: string; time: number; auto: number }

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

// Pins chosen by Jev at compaction. Idempotent: a message already pinned, by the user or not, is left alone.
export function add(sessionID: string, messageID: string, text: string) {
  return (
    table()
      .query("INSERT OR IGNORE INTO fork_pins (session_id, message_id, text, time, auto) VALUES (?, ?, ?, ?, 1)")
      .run(sessionID, messageID, text.slice(0, MAX_PIN_CHARS), Date.now()).changes > 0
  )
}

const MIN_AUTO_CHARS = 40
const AUTO_CHARS = 800
// Candidates per Jev call; Jev's own limit on questions per call has not been measured yet.
const AUTO_BATCH = 6
const AUTO_AT = 0.8
const AUTO_PER_COMPACTION = 3
const AUTO_PER_SESSION = 8

export type Candidate = { message_id: string; text: string }

// The most recent user messages that are long enough to hold a constraint and are not pinned yet.
export function candidates(messages: readonly Candidate[], pinned: readonly Pin[]) {
  const skip = new Set(pinned.map((pin) => pin.message_id))
  return messages
    .filter((message) => message.text.trim().length >= MIN_AUTO_CHARS && !skip.has(message.message_id))
    .slice(-AUTO_BATCH)
}

export function jevRequest(items: readonly Candidate[]) {
  return {
    state: [
      "User messages sent to a coding agent. Decide for each whether it states something the agent must keep following after its context is summarised.",
      ...items.map((item, index) => `[m${index}]\n${item.text.trim().slice(0, AUTO_CHARS)}`),
    ].join("\n\n"),
    questions: Object.fromEntries(
      items.map((_, index) => [
        `m${index}`,
        {
          type: "noul" as const,
          instructions: `Message [m${index}] states a lasting constraint, preference or decision the agent must keep following, not a one-off request`,
        },
      ]),
    ) satisfies Record<string, ForkJev.Question>,
  }
}

// What to pin from Jev's answers: the likeliest candidates from the threshold, within the per-compaction and
// per-session limits (`already` is the number of automatic pins the session holds).
export function picks(items: readonly Candidate[], answers: Record<string, ForkJev.Answer>, already: number) {
  return items
    .flatMap((item, index) => {
      const noul = answers[`m${index}`]?.noul
      return noul !== undefined && noul >= AUTO_AT ? [{ item, noul }] : []
    })
    .toSorted((a, b) => b.noul - a.noul)
    .slice(0, Math.max(0, Math.min(AUTO_PER_COMPACTION, AUTO_PER_SESSION - already)))
    .map((pick) => pick.item)
}

export function list(sessionID: string) {
  return table()
    .query<Pin, [string]>("SELECT message_id, text, time, auto FROM fork_pins WHERE session_id = ? ORDER BY time")
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
    auto INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, message_id)
  )`)
  // Tables created before automatic pins have no `auto` column.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(fork_pins)").all()
  if (!columns.some((column) => column.name === "auto")) db.run("ALTER TABLE fork_pins ADD auto INTEGER NOT NULL DEFAULT 0")
  ready = true
  return db
}

export * as ForkPins from "./pins"
