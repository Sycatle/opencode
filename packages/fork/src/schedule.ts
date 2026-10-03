import path from "path"
import { ForkTelemetry } from "./telemetry"

// Local scheduled routines. A single crontab line runs `schedule tick` every minute; tick
// decides which routines are due. `argv` holds the arguments after the opencode entrypoint;
// leading KEY=VALUE entries are environment variables for the run.

export const MARKER = "# opencode-fork-schedule"
export const STALE_MS = 6 * 60 * 60 * 1000

export type Routine = {
  id: number
  name: string
  cron: string
  dir: string
  argv_json: string
  created: number
  last_run: number | null
  last_status: string | null
  last_exit: number | null
  running_since: number | null
}

type Field = { values: Set<number>; star: boolean }
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field }
export type Parsed = { ok: true; cron: Cron } | { ok: false; error: string }

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const

export function parse(expression: string): Parsed {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return { ok: false, error: `expected 5 fields, got ${parts.length}` }
  const fields: Field[] = []
  for (const [index, part] of parts.entries()) {
    const spec = FIELDS[index]
    const field = parseField(part, spec.min, spec.max)
    if (typeof field === "string") return { ok: false, error: `${spec.name}: ${field}` }
    fields.push(field)
  }
  const [minute, hour, dom, month, dow] = fields
  if (dow.values.has(7)) dow.values.add(0)
  return { ok: true, cron: { minute, hour, dom, month, dow } }
}

function parseField(text: string, min: number, max: number): Field | string {
  const values = new Set<number>()
  for (const item of text.split(",")) {
    const [range, step, extra] = item.split("/")
    if (extra !== undefined) return `invalid "${item}"`
    const size = step === undefined ? 1 : Number(step)
    if (!Number.isInteger(size) || size < 1) return `invalid step in "${item}"`
    const bounds = range === "*" ? [min, max] : range.split("-").map((bound) => (/^\d+$/.test(bound) ? Number(bound) : NaN))
    if (bounds.length > 2 || bounds.some(Number.isNaN)) return `invalid "${item}"`
    const from = bounds[0]
    const end = bounds[1] ?? (step === undefined ? from : max)
    if (from < min || end > max || from > end) return `"${item}" out of range ${min}-${max}`
    for (let value = from; value <= end; value += size) values.add(value)
  }
  return { values, star: text.startsWith("*") }
}

function matchesDay(cron: Cron, date: Date) {
  const dom = cron.dom.values.has(date.getDate())
  const dow = cron.dow.values.has(date.getDay())
  // Vixie semantics: when both day fields are restricted, either one matching is enough.
  return cron.dom.star || cron.dow.star ? dom && dow : dom || dow
}

// Walks forward in real elapsed time and reads local wall-clock fields. A nonexistent local time
// (spring-forward gap) is never visited, so such a run is skipped that day; a repeated local time
// (fall-back) is visited twice, so a routine pinned to it can fire twice.
export function next(expression: string, from: Date) {
  const parsed = parse(expression)
  if (!parsed.ok) throw new Error(`Invalid cron "${expression}": ${parsed.error}`)
  const cron = parsed.cron
  const limit = from.getTime() + 5 * 366 * 24 * 3600_000
  const start = new Date(from)
  start.setSeconds(0, 0)
  let time = start.getTime() + 60_000
  while (time <= limit) {
    const date = new Date(time)
    if (!cron.month.values.has(date.getMonth() + 1) || !matchesDay(cron, date)) {
      time = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
      continue
    }
    if (!cron.hour.values.has(date.getHours())) {
      time += (60 - date.getMinutes()) * 60_000
      continue
    }
    if (cron.minute.values.has(date.getMinutes())) return new Date(time)
    time += 60_000
  }
  return undefined
}

// A routine is due when its next occurrence after the last run (or creation) has passed.
// Occurrences missed while the machine was off collapse into one catch-up run.
export function due(routine: Pick<Routine, "cron" | "created" | "last_run">, now: Date) {
  const occurrence = next(routine.cron, new Date(routine.last_run ?? routine.created))
  return occurrence !== undefined && occurrence.getTime() <= now.getTime()
}

export function buildArgv(input: { prompt: string[]; check?: string; budget?: number }) {
  const prompt = input.prompt.join(" ")
  if (input.check)
    return [
      "auto",
      "--until",
      input.check,
      ...(input.budget !== undefined ? ["--budget", String(input.budget)] : []),
      prompt,
    ]
  return [...(input.budget !== undefined ? [`OPENCODE_FORK_BUDGET_USD=${input.budget}`] : []), "run", prompt]
}

export function splitEnv(argv: readonly string[]) {
  const count = argv.findIndex((arg) => !/^[A-Z_][A-Z0-9_]*=/.test(arg))
  const split = count === -1 ? argv.length : count
  return {
    env: Object.fromEntries(
      argv.slice(0, split).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    ),
    args: argv.slice(split),
  }
}

export function quote(value: string) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

export function crontabLine(input: { home: string; self: readonly string[]; log: string }) {
  return `* * * * * cd ${quote(input.home)} && ${input.self.map(quote).join(" ")} schedule tick >> ${quote(input.log)} 2>&1 ${MARKER}`
}

export function mergeCrontab(existing: string, line: string) {
  return [...stripCrontab(existing), line].join("\n") + "\n"
}

export function removeCrontab(existing: string) {
  const lines = stripCrontab(existing)
  return lines.length ? lines.join("\n") + "\n" : ""
}

function stripCrontab(existing: string) {
  return existing
    .split("\n")
    .filter((line, index, all) => !line.includes(MARKER) && (line !== "" || index < all.length - 1))
}

export type Crontab = { read: () => Promise<string>; write: (text: string) => Promise<void> }

export async function install(crontab: Crontab, line: string) {
  const existing = await crontab.read()
  const merged = mergeCrontab(existing, line)
  if (merged === existing) return false
  await crontab.write(merged)
  return true
}

export async function uninstall(crontab: Crontab) {
  const existing = await crontab.read()
  const removed = removeCrontab(existing)
  if (removed === existing) return false
  await crontab.write(removed)
  return true
}

export function systemCrontab(): Crontab | undefined {
  const binary = Bun.which("crontab")
  if (!binary) return undefined
  return {
    read: async () => {
      const proc = Bun.spawn([binary, "-l"], { stdout: "pipe", stderr: "ignore" })
      const text = await new Response(proc.stdout).text()
      return (await proc.exited) === 0 ? text : ""
    },
    write: async (text) => {
      const proc = Bun.spawn([binary, "-"], { stdin: new Blob([text]), stdout: "inherit", stderr: "inherit" })
      if ((await proc.exited) !== 0) throw new Error("crontab rejected the new table")
    },
  }
}

export function add(input: { name?: string; cron: string; dir: string; argv: readonly string[] }) {
  const result = table()
    .query("INSERT INTO fork_schedules (name, cron, dir, argv_json, created) VALUES (?, ?, ?, ?, ?)")
    .run(input.name ?? "", input.cron, input.dir, JSON.stringify(input.argv), Date.now())
  const id = Number(result.lastInsertRowid)
  if (!input.name) table().query("UPDATE fork_schedules SET name = ? WHERE id = ?").run(`routine-${id}`, id)
  return id
}

export function list() {
  return table().query<Routine, []>("SELECT * FROM fork_schedules ORDER BY id").all()
}

export function get(id: number) {
  return table().query<Routine, [number]>("SELECT * FROM fork_schedules WHERE id = ?").get(id) ?? undefined
}

export function remove(id: number) {
  return table().query("DELETE FROM fork_schedules WHERE id = ?").run(id).changes > 0
}

// Atomic lock: succeeds only if the routine is idle or its previous run went stale.
export function claim(id: number, now = Date.now()) {
  return (
    table()
      .query(
        "UPDATE fork_schedules SET running_since = ?, last_run = ?, last_status = 'running', last_exit = NULL WHERE id = ? AND (running_since IS NULL OR running_since < ?)",
      )
      .run(now, now, id, now - STALE_MS).changes > 0
  )
}

export function finish(id: number, exit: number) {
  table()
    .query("UPDATE fork_schedules SET running_since = NULL, last_status = ?, last_exit = ? WHERE id = ?")
    .run(exit === 0 ? "ok" : "failed", exit, id)
}

export function dueRoutines(now: Date) {
  return list().filter((routine) => due(routine, now))
}

export function logPath(dataDir: string, id: number, now = new Date()) {
  return path.join(dataDir, "schedule", String(id), `${now.toISOString().replaceAll(":", "-")}.log`)
}

// Runs an already claimed routine in the foreground, writing its output to a log file.
export async function execute(routine: Routine, command: readonly string[], log: string) {
  const split = splitEnv(JSON.parse(routine.argv_json) as string[])
  await Bun.write(log, "")
  const started = Date.now()
  const proc = Bun.spawn([...command, ...split.args], {
    cwd: routine.dir,
    env: { ...process.env, ...split.env },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    stdin: "ignore",
  })
  const exit = await proc.exited
  finish(routine.id, exit)
  return { exit, duration: Date.now() - started }
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    dir TEXT NOT NULL,
    argv_json TEXT NOT NULL,
    created INTEGER NOT NULL,
    last_run INTEGER,
    last_status TEXT,
    last_exit INTEGER,
    running_since INTEGER
  )`)
  ready = true
  return db
}

export * as ForkSchedule from "./schedule"
