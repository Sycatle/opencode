import { afterEach, expect, test } from "bun:test"
import os from "os"
import path from "path"

process.env.OPENCODE_FORK_DB ??= path.join(os.tmpdir(), `fork-budget-${process.pid}-${Date.now()}.db`)
const { ForkTelemetry } = await import("../src/telemetry")
const { ForkBudget } = await import("../src/budget")

afterEach(() => {
  delete process.env.OPENCODE_FORK_BUDGET_USD
})

const spend = async (sessionID: string, cost: number, parentSessionID?: string) => {
  ForkTelemetry.measure(sessionID, { agent: "build", parentSessionID, system: [], messages: [], tools: {} })
  await ForkTelemetry.record({
    sessionID,
    messageID: `${sessionID}-${cost}`,
    providerID: "anthropic",
    modelID: "claude",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost,
  })
}

test("no budget configured means no limit", async () => {
  await spend("budget-free", 100)
  expect(ForkBudget.check({ id: "budget-free" }).state).toBe("ok")
})

test("subagent spending counts against the root session budget", async () => {
  process.env.OPENCODE_FORK_BUDGET_USD = "1"
  await spend("budget-root", 0.5)
  await spend("budget-child", 0.3, "budget-root")
  await spend("budget-grandchild", 0.1, "budget-child")
  expect(ForkTelemetry.rootOf("budget-grandchild")).toBe("budget-root")
  expect(ForkBudget.check({ id: "budget-root" })).toMatchObject({ state: "ok" })

  // A fresh subagent has no rows yet: it resolves its root through its parent.
  await spend("budget-child", 0.15, "budget-root")
  expect(ForkBudget.check({ id: "budget-new", parentID: "budget-grandchild" }).state).toBe("wrap-up")

  await spend("budget-root", 0.2)
  expect(ForkBudget.check({ id: "budget-root" }).state).toBe("stop")
})
