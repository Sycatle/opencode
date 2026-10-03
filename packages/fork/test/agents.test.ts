import { afterEach, expect, test } from "bun:test"
import { ForkAgents } from "../src/agents"

afterEach(() => {
  delete process.env.OPENCODE_FORK_ROUTE_SUBAGENTS
  delete process.env.OPENCODE_FORK_MAX_BACKGROUND
})

test("explore runs on the small model unless it pins a model", () => {
  expect(ForkAgents.routeToSmallModel({ name: "explore" })).toBe(true)
  expect(ForkAgents.routeToSmallModel({ name: "explore", model: { modelID: "x", providerID: "y" } })).toBe(false)
  expect(ForkAgents.routeToSmallModel({ name: "general" })).toBe(false)
  process.env.OPENCODE_FORK_ROUTE_SUBAGENTS = "0"
  expect(ForkAgents.routeToSmallModel({ name: "explore" })).toBe(false)
})

test("background concurrency limit defaults to 4 and accepts positive integers", () => {
  expect(ForkAgents.maxBackground()).toBe(4)
  process.env.OPENCODE_FORK_MAX_BACKGROUND = "2"
  expect(ForkAgents.maxBackground()).toBe(2)
  process.env.OPENCODE_FORK_MAX_BACKGROUND = "-1"
  expect(ForkAgents.maxBackground()).toBe(4)
})

const launched = (sessionId: string) => ({
  tool: "task",
  state: { status: "completed", metadata: { background: true, sessionId } },
})

test("a headless run waits for background subagents before exiting", () => {
  const tracker = ForkAgents.backgroundTracker()
  expect(tracker.canExit()).toBe(true)
  tracker.observePart(launched("child"))
  tracker.observePart({ tool: "task", state: { status: "completed", metadata: { sessionId: "foreground" } } })
  expect(tracker.canExit()).toBe(false)
  tracker.observeIdle("child")
  expect(tracker.canExit()).toBe(true)
})

test("a child that finished before its launch was observed does not block exit", () => {
  const tracker = ForkAgents.backgroundTracker()
  tracker.observeIdle("fast")
  tracker.observePart(launched("fast"))
  expect(tracker.canExit()).toBe(true)
})
