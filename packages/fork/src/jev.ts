import { ForkTelemetry } from "./telemetry"

// Shared client for Jev (TypeSafe), the structured classifier behind the Router and the other fork
// decisions that used to ask the small model or follow a heuristic. One call carries a `state` and
// named questions: `choice` (one option among N), `score` (4 levels) and `noul` (probability 0..1).
// Nothing here throws: a failed call is a value, and the caller keeps its previous behaviour.
// What leaves the machine for each use is documented in docs/fork/jev.md.

const DEFAULT_URL = "https://api.typesafe.ai"
const DEFAULT_MODEL = "jev-latest"
const DEFAULT_TIMEOUT_MS = 1500

type Env = Record<string, string | undefined>

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: [string, string, string, string] }
  | { type: "noul"; instructions: string }

export type Answer = { choice?: string; score?: number; noul?: number; confidence?: number }

export type Result =
  | { answers: Record<string, Answer>; ms: number; error?: undefined }
  | { error: string; ms: number; answers?: undefined }

// "off" without a key or with OPENCODE_FORK_<FEATURE>_JEV=0. "shadow" runs Jev next to the old path and
// only journals the comparison; "on" lets Jev decide. Anything else is the feature's default.
export type Mode = "off" | "shadow" | "on"

export function mode(feature: string, env: Env = process.env, fallback: Mode = "on"): Mode {
  if (!env.TYPESAFE_API_KEY) return "off"
  const value = env[`OPENCODE_FORK_${feature}_JEV`]
  if (value === "0") return "off"
  if (value === "shadow") return "shadow"
  if (value === "1" || value === "on") return "on"
  return fallback
}

export function timeout(env: Env = process.env) {
  const value = Number(env.OPENCODE_FORK_JEV_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

export function endpoint(env: Env = process.env) {
  return `${(env.OPENCODE_FORK_JEV_URL || DEFAULT_URL).replace(/\/+$/, "")}/v1/systemone`
}

export function model(env: Env = process.env) {
  return env.OPENCODE_FORK_JEV_MODEL || DEFAULT_MODEL
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// The answers of a response body; undefined when the body has none.
export function answers(body: unknown): Record<string, Answer> | undefined {
  const raw = record(record(body)?.answers)
  if (!raw) return undefined
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) => {
      const answer = record(value)
      if (!answer) return []
      return [
        [
          key,
          {
            choice: typeof answer.choice === "string" ? answer.choice : undefined,
            score: finite(answer.score),
            noul: finite(answer.noul),
            confidence: finite(answer.confidence),
          },
        ],
      ]
    }),
  )
}

// A 0..3 score as a 0..1 level.
export function level(answer: Answer | undefined) {
  return answer?.score === undefined ? undefined : clamp(answer.score / 3)
}

export const clamp = (value: number) => Math.min(1, Math.max(0, value))

// The mean of the answers' own confidences; undefined when there is none.
export function confidence(all: Record<string, Answer>) {
  const values = Object.values(all).flatMap((answer) => (answer.confidence === undefined ? [] : [answer.confidence]))
  return values.length ? clamp(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined
}

// After BREAKER_FAILURES failures in a row Jev is skipped for BREAKER_MS: every feature then takes its fallback
// at once instead of waiting for a timeout on each call. One breaker per transport (the global fetch in use).
const BREAKER_FAILURES = 3
const BREAKER_MS = 5 * 60_000
const breakers = new WeakMap<typeof fetch, { failures: number; until: number }>()
const BREAKER = "breaker"

// When the breaker of a process opened less than BREAKER_MS ago and no call succeeded since: the end of the pause.
export function pausedUntil(now = Date.now()) {
  const opened = table()
    .query<{ id: number; time: number }, [string]>("SELECT id, time FROM fork_jev WHERE feature = ? ORDER BY id DESC LIMIT 1")
    .get(BREAKER)
  if (!opened || opened.time + BREAKER_MS <= now) return undefined
  const since = table().query<{ id: number }, [number]>("SELECT id FROM fork_jev WHERE ok = 1 AND id > ? LIMIT 1").get(opened.id)
  return since ? undefined : opened.time + BREAKER_MS
}

// POST to Jev with a bearer token. The error text says why the caller must keep its old path. `signal`
// cancels the request when the caller is interrupted (the turn is aborted).
export async function ask(
  input: { state: string; questions: Record<string, Question>; signal?: AbortSignal },
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
  timeoutMs = timeout(env),
): Promise<Result> {
  const breaker = breakers.get(fetcher) ?? { failures: 0, until: 0 }
  breakers.set(fetcher, breaker)
  if (breaker.until > Date.now())
    return { error: `Jev paused after ${BREAKER_FAILURES} failures in a row`, ms: 0 }
  const result = await post(input, env, fetcher, timeoutMs)
  // A call the caller cancelled says nothing about Jev's health.
  if (result.error !== undefined && !input.signal?.aborted) {
    breaker.failures++
    if (breaker.failures >= BREAKER_FAILURES) {
      breaker.until = Date.now() + BREAKER_MS
      // Journaled for the real transport only, so the TUI can say that every Jev feature is on its fallback.
      if (fetcher === fetch) journal({ feature: BREAKER, ms: 0, ok: false, error: result.error })
    }
  }
  if (result.error === undefined) breaker.failures = 0
  return result
}

async function post(
  input: { state: string; questions: Record<string, Question>; signal?: AbortSignal },
  env: Env,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Result> {
  const started = Date.now()
  const response = await fetcher(endpoint(env), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
    body: JSON.stringify({ state: input.state, model: model(env), questions: input.questions }),
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  const ms = () => Date.now() - started
  if (response instanceof Error) return { error: `Jev request failed: ${response.message}`, ms: ms() }
  if (!response.ok) return { error: `Jev returned HTTP ${response.status}`, ms: ms() }
  const parsed = answers(await response.json().catch(() => undefined))
  return parsed ? { answers: parsed, ms: ms() } : { error: "Jev response unusable", ms: ms() }
}

export type Entry = {
  feature: string
  session_id?: string
  ms: number
  ok: boolean
  error?: string
  // What Jev decided, and in shadow mode what the old path decided.
  decision?: string
  other?: string
  answers?: Record<string, Answer>
}

export type Row = {
  id: number
  time: number
  feature: string
  session_id: string | null
  ms: number
  ok: number
  error: string | null
  decision: string | null
  other: string | null
  answers: string | null
}

// Journal of Jev calls in fork.db. The state sent to Jev is never stored, only its answers.
export function journal(entry: Entry, time = Date.now()) {
  try {
    table()
      .query(
        `INSERT INTO fork_jev (time, feature, session_id, ms, ok, error, decision, other, answers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        time,
        entry.feature,
        entry.session_id ?? null,
        entry.ms,
        entry.ok ? 1 : 0,
        entry.error ?? null,
        entry.decision ?? null,
        entry.other ?? null,
        entry.answers ? JSON.stringify(entry.answers) : null,
      )
  } catch {}
}

export function recent(limit: number, feature?: string) {
  return table()
    .query<Row, [string | null, string | null, number]>(
      "SELECT * FROM fork_jev WHERE (? IS NULL OR feature = ?) ORDER BY id DESC LIMIT ?",
    )
    .all(feature ?? null, feature ?? null, limit)
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_jev (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    feature TEXT NOT NULL,
    session_id TEXT,
    ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    decision TEXT,
    other TEXT,
    answers TEXT
  )`)
  db.run("CREATE INDEX IF NOT EXISTS fork_jev_feature ON fork_jev (feature, id)")
  ready = true
  return db
}

export * as ForkJev from "./jev"
