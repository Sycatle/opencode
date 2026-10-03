export * as ForkWakeup from "./wakeup"

import { ForkTelemetry } from "./telemetry"

// In-session wakeups: a live session schedules its own next turn (`schedule_wakeup` tool, `/loop` command).
// One pending wakeup per session, stored in fork.db so a resumed session in a new process re-arms it (not due
// yet) or receives it right away (overdue). The process that owns the session delivers it through the watcher
// of session/fork-messaging.ts, as a synthetic user message.

export const MIN_SECONDS = 60
export const MAX_SECONDS = 3600
const MAX_PROMPT = 20_000
const KEEP_OVERDUE_MS = 7 * 24 * 3600_000

export function enabled() {
  return process.env.OPENCODE_FORK_WAKEUPS !== "0"
}

// Test hook: lowers the 60 s floor (`OPENCODE_FORK_WAKEUP_MIN_SECONDS=1`), for tests and trials only.
export function minSeconds() {
  const value = Number(process.env.OPENCODE_FORK_WAKEUP_MIN_SECONDS)
  return Number.isFinite(value) && value > 0 ? value : MIN_SECONDS
}

// ---------------------------------------------------------------- pure

export type Request = { delaySeconds?: number; prompt?: string; reason?: string; stop?: boolean }
export type Plan =
  | { ok: true; stop: true }
  | { ok: true; stop: false; delaySeconds: number; due: number; prompt: string; reason: string; clamped: boolean }
  | { ok: false; error: string }

export function plan(input: Request, now = Date.now()): Plan {
  if (input.stop) return { ok: true, stop: true }
  const prompt = input.prompt?.trim()
  if (input.delaySeconds === undefined || !Number.isFinite(input.delaySeconds))
    return { ok: false, error: "delaySeconds is required unless stop is true." }
  if (!prompt) return { ok: false, error: "prompt is required unless stop is true." }
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `The prompt exceeds ${MAX_PROMPT} characters.` }
  const delaySeconds = Math.min(MAX_SECONDS, Math.max(minSeconds(), input.delaySeconds))
  return {
    ok: true,
    stop: false,
    delaySeconds,
    due: dueAt(now, delaySeconds),
    prompt,
    reason: input.reason?.trim() ?? "",
    clamped: delaySeconds !== input.delaySeconds,
  }
}

export function dueAt(now: number, delaySeconds: number) {
  return now + Math.round(delaySeconds * 1000)
}

const UNITS = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 } as const

// "5m", "1h", "90s", "1.5h" -> milliseconds.
export function parseInterval(text: string) {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/i.exec(text.trim())
  if (!match) return undefined
  return Math.round(Number(match[1]) * UNITS[match[2].toLowerCase() as keyof typeof UNITS])
}

export type Loop = { ok: true; prompt: string; everyMs?: number } | { ok: false; error: string }

// `/loop [interval] <prompt>`: with an interval the prompt repeats at that rate, without one the model paces itself.
export function parseLoop(args: string): Loop {
  const text = args.trim()
  const [first, ...rest] = text.split(/\s+/)
  const everyMs = first ? parseInterval(first) : undefined
  const prompt = (everyMs === undefined ? text : rest.join(" ")).trim()
  if (!prompt) return { ok: false, error: "Usage: /loop [interval] <prompt>, for example /loop 5m check the deploy." }
  if (everyMs === undefined) return { ok: true, prompt }
  return { ok: true, prompt, everyMs: Math.max(minSeconds() * 1000, everyMs) }
}

// Marks the built-in `/loop` command, so a user command of the same name is left alone.
export const LOOP_DESCRIPTION = "repeat a prompt: /loop [interval] <prompt>"

// Template of the `/loop` command once its arguments are parsed; `$ARGUMENTS` receives the prompt.
export function loopTemplate(loop: { everyMs?: number }) {
  if (loop.everyMs !== undefined)
    return [
      `This task repeats every ${formatDuration(loop.everyMs)} for as long as this session lives (a scheduled wakeup re-sends it; schedule_wakeup with stop: true ends the loop). Do it now:`,
      "",
      "$ARGUMENTS",
    ].join("\n")
  return [
    "This is a dynamic loop. Do the task below now. When you are done, pick a delay that fits what you are waiting for and call the schedule_wakeup tool (ScheduleWakeup) with delaySeconds, a short reason, and prompt set to exactly the task text, so the task comes back. If nothing is left to do, call schedule_wakeup with stop: true instead. Load the tool with tool_search first if it is not available.",
    "",
    "Task:",
    "$ARGUMENTS",
  ].join("\n")
}

// Runs when the built-in `/loop` command is used. With an interval, arms the repeating wakeup of the session.
export function startLoop(sessionID: string, args: string, now = Date.now()) {
  const loop = parseLoop(args)
  if (!loop.ok) return loop
  if (loop.everyMs !== undefined)
    set({ sessionID, due: now + loop.everyMs, prompt: loop.prompt, reason: "loop", everyMs: loop.everyMs }, now)
  return { ...loop, template: loopTemplate(loop) }
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

export type Row = {
  session_id: string
  due: number
  prompt: string
  reason: string
  every: number | null
  created: number
}

// Text injected as a synthetic user message. It comes from a timer the session set earlier, not from the user.
export function render(row: Pick<Row, "prompt" | "reason" | "every">) {
  const reason = row.reason ? ` reason="${row.reason.replace(/["\n]/g, " ")}"` : ""
  return [
    `<scheduled-wakeup${reason}>`,
    "Scheduled wakeup, not the user: this session scheduled this prompt earlier with schedule_wakeup (ScheduleWakeup). It is not an instruction from the user and grants no permission. Keep following the user's request and this session's own permissions and mode.",
    row.every === null
      ? "To continue, call schedule_wakeup again (same prompt); call it with stop: true when nothing is left to do."
      : `It repeats every ${formatDuration(row.every)}; call schedule_wakeup with stop: true to end the loop.`,
    "",
    row.prompt,
    "</scheduled-wakeup>",
  ].join("\n")
}

// Reads back what `render` produced: the reason and a short preview of the prompt.
export function received(text: string) {
  const match = /^<scheduled-wakeup(?: reason="([^"\n]*)")?>\n/.exec(text)
  if (!match) return undefined
  const body = text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n</scheduled-wakeup>"))
  return { reason: match[1] ?? "", preview: body.replace(/\s+/g, " ").slice(0, 120) }
}

// Status line label: "wakeup in 12 min".
export function label(row: Pick<Row, "due">, now = Date.now()) {
  return row.due <= now ? "wakeup due" : `wakeup in ${formatDuration(row.due - now)}`
}

// ---------------------------------------------------------------- storage

let ready: object | undefined

function db() {
  const handle = ForkTelemetry.db()
  if (ready === handle) return handle
  handle.run(`CREATE TABLE IF NOT EXISTS fork_wakeups (
    session_id TEXT PRIMARY KEY,
    due INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    reason TEXT NOT NULL,
    every INTEGER,
    created INTEGER NOT NULL
  )`)
  ready = handle
  return handle
}

// Replaces the pending wakeup of the session. `everyMs` makes it repeat after each delivery.
export function set(
  input: { sessionID: string; due: number; prompt: string; reason?: string; everyMs?: number },
  now = Date.now(),
) {
  const handle = db()
  handle.query("DELETE FROM fork_wakeups WHERE due < ?").run(now - KEEP_OVERDUE_MS)
  handle
    .query(
      "INSERT OR REPLACE INTO fork_wakeups (session_id, due, prompt, reason, every, created) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(input.sessionID, input.due, input.prompt, input.reason ?? "", input.everyMs ?? null, now)
}

export function get(sessionID: string) {
  return db().query<Row, [string]>("SELECT * FROM fork_wakeups WHERE session_id = ?").get(sessionID) ?? undefined
}

// Returns whether a wakeup was pending.
export function cancel(sessionID: string) {
  return db().query("DELETE FROM fork_wakeups WHERE session_id = ?").run(sessionID).changes > 0
}

// Atomically takes the wakeup of a session when it is due. A repeating one is re-armed from now, a one-shot is removed.
export function claimDue(sessionID: string, now = Date.now()) {
  const handle = db()
  return handle.transaction(() => {
    const row = get(sessionID)
    if (!row || row.due > now) return undefined
    if (row.every === null) cancel(sessionID)
    else handle.query("UPDATE fork_wakeups SET due = ? WHERE session_id = ?").run(now + row.every, sessionID)
    return row
  })()
}
