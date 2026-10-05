import { expect, test } from "bun:test"
import { ForkSummary } from "../src/summary"
import type { ForkTelemetry } from "../src/telemetry"

const step = (overrides: Partial<ForkTelemetry.Step>): ForkTelemetry.Step => ({
  id: 0,
  session_id: "root",
  parent_session_id: null,
  message_id: "m",
  agent: "build",
  provider_id: "anthropic",
  model_id: "claude",
  time: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cache_read: 0,
  cache_write: 0,
  cost: 0,
  tool_count: 0,
  message_count: 0,
  media_count: 0,
  chars_system: 0,
  chars_tools: 0,
  chars_history: 0,
  chars_tool_output: 0,
  est_system: 0,
  est_tools: 0,
  est_history: 0,
  est_tool_output: 0,
  tool_chars: null,
  ...overrides,
})

test("summarizes the last own turn, the whole tree cost and each subagent", () => {
  const summary = ForkSummary.summarize(
    [
      step({ input: 100, cache_write: 900, cost: 0.02 }),
      step({ session_id: "child", agent: "explore", model_id: "haiku", input: 50, cache_read: 450, cost: 0.001 }),
      step({ input: 100, cache_read: 900, cost: 0.005, est_system: 400, est_tools: 600 }),
    ],
    "root",
  )
  expect(summary.turns).toBe(2)
  expect(summary.cost).toBeCloseTo(0.026)
  expect(summary.last?.cacheHit).toBeCloseTo(0.9)
  expect(summary.last?.breakdown.tools).toBe(600)
  expect(summary.cacheHit).toBeCloseTo(1350 / 2500)
  expect(summary.children).toEqual([{ sessionID: "child", agent: "explore", model: "haiku", turns: 1, cost: 0.001 }])
})

test("an empty session has no last turn", () => {
  expect(ForkSummary.summarize([], "root").last).toBeUndefined()
})

test("shares round to exactly 100", () => {
  const value = ForkSummary.shares({ system: 1, tools: 1, history: 1, tool_output: 0 })
  expect(value).toEqual({ system: 34, tools: 33, history: 33, tool_output: 0 })
  expect(ForkSummary.shares({ system: 0, tools: 0, history: 0, tool_output: 0 })).toBeUndefined()
})

test("model ids and subagent titles are shortened for the sidebar", () => {
  expect(ForkSummary.shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5")
  expect(ForkSummary.shortModel("gpt-5")).toBe("gpt-5")
  expect(ForkSummary.subagentTitle("Find discount computation (@explore subagent)", "explore")).toBe(
    "Find discount computation",
  )
  expect(ForkSummary.subagentTitle(undefined, "explore")).toBe("explore")
})

test("budget level warns at 80% and flags overspend", () => {
  expect(ForkSummary.budgetLevel(1, undefined)).toBeUndefined()
  expect(ForkSummary.budgetLevel(0.5, 1)).toBe("ok")
  expect(ForkSummary.budgetLevel(0.8, 1)).toBe("warning")
  expect(ForkSummary.budgetLevel(1.1, 1)).toBe("exceeded")
})

test("quota resets show the time today and the weekday otherwise", () => {
  const now = new Date(2026, 9, 3, 14, 0).getTime()
  expect(ForkSummary.formatReset(new Date(2026, 9, 3, 18, 0).getTime(), now, "en-GB")).toBe("18:00")
  expect(ForkSummary.formatReset(new Date(2026, 9, 5, 10, 0).getTime(), now, "en-GB")).toBe("Mon 10:00")
})

test("quota level follows the most used window and any limited status", () => {
  const window = (utilization: number, status = "allowed") => ({ utilization, status })
  expect(ForkSummary.quotaLevel([window(0.11), window(0.25)])).toBe("ok")
  expect(ForkSummary.quotaLevel([window(0.11), window(0.85)])).toBe("warning")
  expect(ForkSummary.quotaLevel([window(0.3, "rejected"), undefined])).toBe("exceeded")
})

test("quota pace compares usage with the time elapsed in the window", () => {
  const now = 1_000_000_000_000
  const window = (utilization: number, elapsed: number, length: number, status = "allowed") => ({
    utilization,
    status,
    reset: now + (1 - elapsed) * length,
  })
  const five = ForkSummary.FIVE_HOUR
  expect(ForkSummary.quotaPace(window(0.16, 0.6, five), five, now).level).toBe("ok")
  expect(ForkSummary.quotaPace(window(0.5, 0.2, five), five, now).level).toBe("error")
  expect(ForkSummary.quotaPace(window(0.4, 0.25, five), five, now).level).toBe("warning")
  expect(ForkSummary.quotaPace(window(0.4, 0.05, five), five, now).level).toBe("ok")
  expect(ForkSummary.quotaPace(window(0.95, 0.9, five), five, now).level).toBe("error")
  expect(ForkSummary.quotaPace(window(0.3, 0.5, five, "rejected"), five, now).level).toBe("error")

  const fast = ForkSummary.quotaPace(window(0.5, 0.2, five), five, now)
  expect(fast.exhaustAt).toBeCloseTo(now + 0.2 * five, -3)
  expect(ForkSummary.quotaPace(window(0.16, 0.6, five), five, now).exhaustAt).toBeUndefined()
})

test("remaining time is compact", () => {
  const now = 1_000_000_000_000
  expect(ForkSummary.formatRemaining(now + 192 * 60_000, now, "en-GB")).toBe("3h12")
  expect(ForkSummary.formatRemaining(now + 25 * 3600_000, now, "en-GB")).toBe("1d1h")
  expect(ForkSummary.formatRemaining(now + 40 * 60_000, now, "en-GB")).toBe("40m")
  expect(ForkSummary.formatRemaining(now - 1000, now, "en-GB")).toBe("now")
})

test("quota text follows the system language", () => {
  const now = new Date(2026, 9, 3, 20, 31).getTime()
  const monday = new Date(2026, 9, 5, 21, 48).getTime()
  const reset = now + (5 * 1440 + 16 * 60) * 60_000
  expect(ForkSummary.systemLocale({ LANG: "fr_FR.UTF-8" })).toBe("fr-FR")
  expect(ForkSummary.systemLocale({ LC_ALL: "en_US.UTF-8", LANG: "fr_FR.UTF-8" })).toBe("en-GB")
  expect(ForkSummary.systemLocale({ LANG: "C.UTF-8" })).toBe("en-GB")
  expect(ForkSummary.systemLocale({ OPENCODE_FORK_LOCALE: "fr", LANG: "en_US.UTF-8" })).toBe("fr")
  expect(ForkSummary.windowLabel("7d", "fr-FR")).toBe("7j")
  expect(ForkSummary.windowLabel("7d", "en-GB")).toBe("7d")
  expect(ForkSummary.resetIn(reset, now, "fr-FR")).toBe("reset dans 5j16h")
  expect(ForkSummary.resetIn(reset, now, "en-GB")).toBe("reset in 5d16h")
  const week = reset + 2 * 86_400_000
  expect(ForkSummary.quotaForecast("7d", { exhaustAt: monday }, week, { now, locale: "fr-FR" })).toMatch(
    /^Estimation : à ce rythme, le quota hebdomadaire sera épuisé lundi à 21:48, soit \d+j\d+h avant le reset\.$/,
  )
  expect(ForkSummary.quotaForecast("7d", { exhaustAt: monday }, week, { now, locale: "en-GB" })).toMatch(
    /^Estimate: at this pace the weekly quota runs out Monday 21:48, \d+d\d+h before the reset\.$/,
  )
  expect(ForkSummary.quotaForecast("5h", { ratio: 0.62 }, week, { now, locale: "fr-FR" })).toBe(
    "Estimation : environ 62 % utilisés au reset à ce rythme.",
  )
  expect(ForkSummary.quotaForecast("5h", {}, week, { now, locale: "en-GB" })).toBeUndefined()
  expect(ForkSummary.formatRemaining(now + 40 * 60_000, now, "fr-FR")).toBe("40 min")
  expect(ForkSummary.paceLegend("fr-FR")).toBe("│ = rythme régulier")
})
