import type { ForkTelemetry } from "./telemetry"

// Display-ready aggregates for the TUI widgets.

export type Breakdown = { system: number; tools: number; history: number; tool_output: number }

export function summarize(steps: readonly ForkTelemetry.Step[], sessionID: string) {
  const own = steps.filter((step) => step.session_id === sessionID)
  const last = own.at(-1)
  const inputSide = (step: ForkTelemetry.Step) => step.input + step.cache_read + step.cache_write
  const totalInput = steps.reduce((sum, step) => sum + inputSide(step), 0)
  return {
    last: last
      ? {
          context: inputSide(last),
          cost: last.cost,
          cacheHit: ratio(last.cache_read, inputSide(last)),
          breakdown: {
            system: last.est_system,
            tools: last.est_tools,
            history: last.est_history,
            tool_output: last.est_tool_output,
          } satisfies Breakdown,
        }
      : undefined,
    turns: own.length,
    cost: steps.reduce((sum, step) => sum + step.cost, 0),
    cacheHit: ratio(
      steps.reduce((sum, step) => sum + step.cache_read, 0),
      totalInput,
    ),
    children: [...new Set(steps.map((step) => step.session_id))]
      .filter((id) => id !== sessionID)
      .map((id) => {
        const rows = steps.filter((step) => step.session_id === id)
        return {
          sessionID: id,
          agent: rows[0]?.agent ?? "unknown",
          model: rows.at(-1)?.model_id ?? "",
          turns: rows.length,
          cost: rows.reduce((sum, step) => sum + step.cost, 0),
        }
      }),
  }
}

// Share of each category, rounded so the parts add up to 100.
export function shares(value: Breakdown) {
  const total = value.system + value.tools + value.history + value.tool_output
  if (total === 0) return undefined
  const raw = Object.entries(value).map(([key, part]) => [key, (part / total) * 100] as const)
  const floored = raw.map(([key, part]) => [key, Math.floor(part)] as const)
  const missing = 100 - floored.reduce((sum, [, part]) => sum + part, 0)
  const order = raw
    .map(([key, part], index) => ({ key, index, rest: part - Math.floor(part) }))
    .toSorted((a, b) => b.rest - a.rest)
    .slice(0, missing)
    .map((item) => item.index)
  return Object.fromEntries(
    floored.map(([key, part], index) => [key, part + (order.includes(index) ? 1 : 0)]),
  ) as Breakdown
}

// "claude-haiku-4-5-20251001" -> "haiku-4-5": the sidebar is narrow.
export function shortModel(modelID: string) {
  return modelID.replace(/^claude-/, "").replace(/-\d{8}$/, "")
}

// Task titles end with " (@<agent> subagent)", which the widget already shows.
export function subagentTitle(title: string | undefined, agent: string) {
  return title?.replace(/\s*\(@[^)]*subagent\)$/, "").trim() || agent
}

// Locale for quota text: OPENCODE_FORK_LOCALE, then the system's time and language settings, else English.
// English uses en-GB so times stay on a 24-hour clock.
export function systemLocale(env: Record<string, string | undefined> = process.env) {
  const tag = [env.OPENCODE_FORK_LOCALE, env.LC_ALL, env.LC_TIME, env.LANG]
    .map((value) => value?.split(".")[0]?.replace("_", "-"))
    .find(
      (value) =>
        value && /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(value) && Intl.DateTimeFormat.supportedLocalesOf([value]).length > 0,
    )
  return !tag || tag.toLowerCase().startsWith("en") ? "en-GB" : tag
}

const french = (locale: string) => locale.toLowerCase().startsWith("fr")

// "18:00" today, "Mon 10:00" / "lun. 10:00" on another day ("lundi 10:00" with a long weekday).
export function formatReset(
  reset: number,
  now = Date.now(),
  locale = systemLocale(),
  weekday: "short" | "long" = "short",
) {
  const date = new Date(reset)
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(locale, { weekday })} ${time}`
}

// "3h12" under a day, "3d4h" ("3j4h") beyond, "now" once the reset has passed.
export function formatRemaining(reset: number, now = Date.now(), locale = systemLocale()) {
  const fr = french(locale)
  const minutes = Math.max(0, Math.floor((reset - now) / 60_000))
  if (minutes === 0) return fr ? "maintenant" : "now"
  if (minutes < 60) return `${minutes}${fr ? " min" : "m"}`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`
  return `${Math.floor(minutes / 1440)}${fr ? "j" : "d"}${Math.floor((minutes % 1440) / 60)}h`
}

// The window names follow the language: 5h / 7d, 5h / 7j.
export function windowLabel(id: "5h" | "7d", locale = systemLocale()) {
  return id === "7d" && french(locale) ? "7j" : id
}

// "reset in 5d16h" / "reset dans 5j16h".
export function resetIn(reset: number, now = Date.now(), locale = systemLocale()) {
  return `reset ${french(locale) ? "dans" : "in"} ${formatRemaining(reset, now, locale)}`
}

// "reset 19:25 (in 59m)" / "reset 19:25 (dans 59 min)".
export function resetAt(reset: number, now = Date.now(), locale = systemLocale()) {
  return `reset ${formatReset(reset, now, locale)} (${french(locale) ? "dans" : "in"} ${formatRemaining(reset, now, locale)})`
}

// What the │ mark on a quota bar means.
export function paceLegend(locale = systemLocale()) {
  return french(locale) ? "│ = rythme régulier" : "│ = steady pace"
}

// What the current pace means for a quota window, as a full sentence for the sidebar: either when it would
// run out (with the margin before the reset) or, when it would not, how much would be used at the reset.
// Early in a window the pace is too noisy to project.
export function quotaForecast(
  window: "5h" | "7d",
  pace: { ratio?: number; exhaustAt?: number },
  reset: number,
  options: { now?: number; locale?: string } = {},
) {
  const locale = options.locale ?? systemLocale()
  const now = options.now ?? Date.now()
  const fr = french(locale)
  if (pace.exhaustAt !== undefined) {
    const when = formatReset(pace.exhaustAt, now, locale, "long")
    const margin = formatRemaining(reset, pace.exhaustAt, locale)
    if (fr) {
      const time = when.includes(" ") ? when.replace(/ (?=\S+$)/, " à ") : `à ${when}`
      return `Estimation : à ce rythme, le quota ${window === "7d" ? "hebdomadaire" : "des 5 heures"} sera épuisé ${time}, soit ${margin} avant le reset.`
    }
    const time = when.includes(" ") ? when : `at ${when}`
    return `Estimate: at this pace the ${window === "7d" ? "weekly" : "5-hour"} quota runs out ${time}, ${margin} before the reset.`
  }
  if (pace.ratio === undefined) return undefined
  const used = Math.round(pace.ratio * 100)
  return fr
    ? `Estimation : environ ${used} % utilisés au reset à ce rythme.`
    : `Estimate: about ${used}% used at the reset at this pace.`
}

export function quotaLevel(windows: readonly ({ utilization: number; status: string } | undefined)[]) {
  const present = windows.filter((window) => window !== undefined)
  if (present.some((window) => window.status !== "allowed" || window.utilization >= 1)) return "exceeded" as const
  if (present.some((window) => window.utilization >= 0.8)) return "warning" as const
  return "ok" as const
}

export const FIVE_HOUR = 5 * 3600_000
export const SEVEN_DAY = 7 * 86_400_000

// How a quota window is being used against the time left before it resets.
// `ratio` is utilization over the share of the window already elapsed: 1 means "on pace to
// finish exactly at the reset", 2 means "twice as fast". Early in a window it is too noisy to judge.
export function quotaPace(
  window: { utilization: number; reset: number; status: string },
  length: number,
  now = Date.now(),
) {
  const elapsed = Math.min(1, Math.max(0, 1 - (window.reset - now) / length))
  const ratio = elapsed >= 0.1 ? window.utilization / elapsed : undefined
  const level =
    window.status !== "allowed" ||
    window.utilization >= 0.9 ||
    (ratio !== undefined && window.utilization >= 0.5 && ratio >= 2)
      ? ("error" as const)
      : window.utilization >= 0.8 || (ratio !== undefined && window.utilization >= 0.3 && ratio >= 1.5)
        ? ("warning" as const)
        : ("ok" as const)
  // Only worth announcing when the window would fill before it resets.
  const exhaustAt =
    level !== "ok" && ratio !== undefined && ratio > 1 && window.utilization < 1
      ? now + ((1 - window.utilization) / window.utilization) * elapsed * length
      : undefined
  return {
    elapsed,
    ratio,
    level,
    exhaustAt: exhaustAt !== undefined && exhaustAt < window.reset ? exhaustAt : undefined,
  }
}

export function budgetLevel(spent: number, limit: number | undefined) {
  if (limit === undefined) return undefined
  const used = spent / limit
  if (used >= 1) return "exceeded" as const
  if (used >= 0.8) return "warning" as const
  return "ok" as const
}

function ratio(part: number, total: number) {
  return total === 0 ? undefined : part / total
}

export * as ForkSummary from "./summary"
