import { ForkTelemetry } from "./telemetry"

// Subscription quotas. With a Claude subscription, every response carries
// `anthropic-ratelimit-unified-*` headers: utilization and reset time of the
// 5-hour window and of the weekly window. API-key responses do not, so a stored
// snapshot also tells the UI that the session runs on a subscription.

export type Window = { utilization: number; reset: number; status: string }

export type Snapshot = {
  provider: string
  five_hour?: Window
  seven_day?: Window
  status: string
  limiting?: string
  time: number
}

const SESSION_HEADER = "x-opencode-session-id"

export function parse(headers: Headers, httpStatus?: number): Snapshot | undefined {
  const codex = headers.has("x-codex-primary-window-requests") || headers.has("x-codex-primary-used-percent")
  if (codex) {
    const window = (prefix: "primary" | "secondary"): Window | undefined => {
      const duration = Number(headers.get(`x-codex-${prefix}-window-minutes`))
      const utilization = Number(headers.get(`x-codex-${prefix}-used-percent`))
      const reset = headers.get(`x-codex-${prefix}-reset-at`)
      if (!Number.isFinite(duration) || !Number.isFinite(utilization) || reset === null) return undefined
      if (duration !== 300 && duration !== 10_080) return undefined
      const resetAt = Date.parse(reset)
      if (!Number.isFinite(resetAt)) return undefined
      return { utilization: utilization / 100, reset: resetAt, status: httpStatus === 429 ? "rejected" : "allowed" }
    }
    const primary = window("primary")
    const secondary = window("secondary")
    const windows = [
      [primary, Number(headers.get("x-codex-primary-window-minutes"))],
      [secondary, Number(headers.get("x-codex-secondary-window-minutes"))],
    ] as const
    const five = windows.find((item) => item[1] === 300)?.[0]
    const seven = windows.find((item) => item[1] === 10_080)?.[0]
    if (!five && !seven) return undefined
    const status = httpStatus === 429 ? "rejected" : "allowed"
    return {
      provider: "openai",
      five_hour: five,
      seven_day: seven,
      status,
      limiting: status === "rejected" ? (five ? "five_hour" : "seven_day") : undefined,
      time: Date.now(),
    }
  }
  const get = (key: string) => headers.get(`anthropic-ratelimit-unified-${key}`)
  const status = get("status")
  if (!status) return undefined
  const window = (id: string): Window | undefined => {
    const utilization = Number(get(`${id}-utilization`))
    const reset = Number(get(`${id}-reset`))
    if (!Number.isFinite(utilization) || get(`${id}-utilization`) === null) return undefined
    return { utilization, reset: Number.isFinite(reset) ? reset * 1000 : 0, status: get(`${id}-status`) ?? status }
  }
  return {
    provider: "anthropic",
    five_hour: window("5h"),
    seven_day: window("7d"),
    status,
    limiting: get("representative-claim") ?? undefined,
    time: Date.now(),
  }
}

// Called from the provider fetch layer on every response; never throws.
export function observe(response: Headers, request: HeadersInit | undefined, httpStatus?: number) {
  try {
    const snapshot = parse(response, httpStatus)
    if (!snapshot) return
    const db = table()
    db.query("INSERT OR REPLACE INTO fork_quota (provider, data, time) VALUES (?, ?, ?)").run(
      snapshot.provider,
      JSON.stringify(snapshot),
      snapshot.time,
    )
    const sessionID = request ? new Headers(request).get(SESSION_HEADER) : null
    if (sessionID && snapshot.five_hour)
      db.query(
        "INSERT OR IGNORE INTO fork_quota_session (session_id, provider, start_utilization, start_reset) VALUES (?, ?, ?, ?)",
      ).run(sessionID, snapshot.provider, snapshot.five_hour.utilization, snapshot.five_hour.reset)
  } catch {}
}

// Headers are only seen on requests: an older snapshot no longer describes the windows.
export const FRESH_MS = 6 * 60 * 60 * 1000

// The latest snapshot for a provider, if recent enough to display.
export function fresh(provider = "anthropic", now = Date.now()) {
  const snapshot = latest(provider)
  return snapshot && now - snapshot.time < FRESH_MS ? snapshot : undefined
}

export function latest(provider = "anthropic") {
  const row = table()
    .query<{ data: string }, [string]>("SELECT data FROM fork_quota WHERE provider = ?")
    .get(provider)
  return row ? (JSON.parse(row.data) as Snapshot) : undefined
}

// Percentage points of the 5-hour window consumed since the session's first request.
export function windowSpent(sessionID: string, provider = "anthropic") {
  const start = table()
    .query<{ start_utilization: number; start_reset: number }, [string, string]>(
      "SELECT start_utilization, start_reset FROM fork_quota_session WHERE session_id = ? AND provider = ?",
    )
    .get(sessionID, provider)
  const current = latest(provider)?.five_hour
  if (!start || !current) return undefined
  return spentPoints(start, current)
}

export function spentPoints(start: { start_utilization: number; start_reset: number }, current: Window) {
  // A reset in between: what was left of the old window plus the new usage.
  const used =
    current.reset === start.start_reset
      ? current.utilization - start.start_utilization
      : 1 - start.start_utilization + current.utilization
  return Math.max(0, Math.round(used * 1000) / 10)
}

// Waiting point for autonomous runs: undefined when work can continue now.
export function waitUntil(threshold: number, provider = "anthropic", now = Date.now()) {
  const snapshot = latest(provider)
  const window = snapshot?.five_hour
  if (!snapshot || !window || window.reset <= now) return undefined
  if (snapshot.status === "allowed" && window.utilization < threshold) return undefined
  return window.reset
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run("CREATE TABLE IF NOT EXISTS fork_quota (provider TEXT PRIMARY KEY, data TEXT NOT NULL, time INTEGER NOT NULL)")
  db.run(`CREATE TABLE IF NOT EXISTS fork_quota_session (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    start_utilization REAL NOT NULL,
    start_reset INTEGER NOT NULL,
    PRIMARY KEY (session_id, provider)
  )`)
  ready = true
  return db
}

export * as ForkQuota from "./quota"
