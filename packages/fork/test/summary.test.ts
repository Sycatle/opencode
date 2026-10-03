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
  expect(ForkSummary.formatReset(new Date(2026, 9, 3, 18, 0).getTime(), now)).toBe("18:00")
  expect(ForkSummary.formatReset(new Date(2026, 9, 5, 10, 0).getTime(), now)).toBe("Mon 10:00")
})

test("quota level follows the most used window and any limited status", () => {
  const window = (utilization: number, status = "allowed") => ({ utilization, status })
  expect(ForkSummary.quotaLevel([window(0.11), window(0.25)])).toBe("ok")
  expect(ForkSummary.quotaLevel([window(0.11), window(0.85)])).toBe("warning")
  expect(ForkSummary.quotaLevel([window(0.3, "rejected"), undefined])).toBe("exceeded")
})
