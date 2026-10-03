import { afterEach, expect, test } from "bun:test"
import os from "os"
import path from "path"

// Always a fresh database: an inherited OPENCODE_FORK_DB may hold rows from earlier runs.
process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-quota-${process.pid}-${Date.now()}.db`)
const { ForkQuota } = await import("../src/quota")
const { ForkBudget } = await import("../src/budget")

afterEach(() => {
  delete process.env.OPENCODE_FORK_BUDGET_WINDOW
})

// Header values captured from a real Claude subscription response.
const headers = (five: string, reset = "1791046800", status = "allowed") =>
  new Headers({
    "anthropic-ratelimit-unified-5h-reset": reset,
    "anthropic-ratelimit-unified-5h-status": status,
    "anthropic-ratelimit-unified-5h-utilization": five,
    "anthropic-ratelimit-unified-7d-reset": "1791543600",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.25",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-status": status,
  })

test("parses the subscription windows and ignores API-key responses", () => {
  const snapshot = ForkQuota.parse(headers("0.11"))
  expect(snapshot?.five_hour).toEqual({ utilization: 0.11, reset: 1791046800000, status: "allowed" })
  expect(snapshot?.seven_day?.utilization).toBe(0.25)
  expect(snapshot?.limiting).toBe("five_hour")
  expect(ForkQuota.parse(new Headers({ "anthropic-ratelimit-requests-limit": "50" }))).toBeUndefined()
})

test("window points are measured from the session's first request, across a reset", () => {
  ForkQuota.observe(headers("0.11"), { "x-opencode-session-id": "quota-root" })
  ForkQuota.observe(headers("0.18"), { "x-opencode-session-id": "quota-root" })
  expect(ForkQuota.windowSpent("quota-root")).toBe(7)
  expect(ForkQuota.latest()?.five_hour?.utilization).toBe(0.18)
  expect(ForkQuota.spentPoints({ start_utilization: 0.9, start_reset: 1 }, { utilization: 0.05, reset: 2, status: "allowed" })).toBe(15)
})

test("the window budget wraps up then stops the session", () => {
  process.env.OPENCODE_FORK_BUDGET_WINDOW = "10"
  ForkQuota.observe(headers("0.40"), { "x-opencode-session-id": "quota-budget" })
  expect(ForkBudget.check({ id: "quota-budget" }).state).toBe("ok")
  ForkQuota.observe(headers("0.51"), { "x-opencode-session-id": "quota-budget" })
  const wrap = ForkBudget.check({ id: "quota-budget" })
  expect(wrap.state).toBe("wrap-up")
  if (wrap.state !== "ok") expect(ForkBudget.describe(wrap)).toBe("11 points of the 5-hour window used of 10")
  ForkQuota.observe(headers("0.55"), { "x-opencode-session-id": "quota-budget" })
  expect(ForkBudget.check({ id: "quota-budget" }).state).toBe("stop")
})

test("autonomous runs wait for the reset above the threshold or when limited", () => {
  const future = String(Math.floor(Date.now() / 1000) + 3600)
  ForkQuota.observe(headers("0.50", future), undefined)
  expect(ForkQuota.waitUntil(0.9)).toBeUndefined()
  ForkQuota.observe(headers("0.95", future), undefined)
  expect(ForkQuota.waitUntil(0.9)).toBe(Number(future) * 1000)
  ForkQuota.observe(headers("0.30", future, "rejected"), undefined)
  expect(ForkQuota.waitUntil(0.9)).toBe(Number(future) * 1000)
})
