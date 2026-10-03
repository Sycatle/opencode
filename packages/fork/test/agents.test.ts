import { afterEach, expect, test } from "bun:test"
import { ForkAgents } from "../src/agents"

afterEach(() => {
  delete process.env.OPENCODE_FORK_ROUTE_SUBAGENTS
  delete process.env.OPENCODE_FORK_MAX_BACKGROUND
  delete process.env.OPENCODE_FORK_SUBAGENT_EFFORT
  delete process.env.OPENCODE_FORK_SUBAGENT_INHERIT
})

test("defaultVariant picks the lowest effort variant for explore", () => {
  expect(ForkAgents.defaultVariant({ name: "explore" }, ["low", "medium", "high"])).toBe("low")
  expect(ForkAgents.defaultVariant({ name: "explore" }, ["none", "minimal", "low"])).toBe("minimal")
  expect(ForkAgents.defaultVariant({ name: "explore" }, ["none", "high"])).toBe("none")
})

test("defaultVariant leaves other agents, explicit variants and variant-less models alone", () => {
  expect(ForkAgents.defaultVariant({ name: "general" }, ["low"])).toBeUndefined()
  expect(ForkAgents.defaultVariant({ name: "explore", variant: "high" }, ["low"])).toBeUndefined()
  expect(ForkAgents.defaultVariant({ name: "explore" }, [])).toBeUndefined()
  expect(ForkAgents.defaultVariant({ name: "explore" }, ["medium", "high"])).toBeUndefined()
})

test("defaultVariant can be disabled", () => {
  process.env.OPENCODE_FORK_SUBAGENT_EFFORT = "0"
  expect(ForkAgents.defaultVariant({ name: "explore" }, ["low"])).toBeUndefined()
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

test("historyBefore keeps the messages strictly before the pending turn", () => {
  const messages = [{ info: { id: "u1" } }, { info: { id: "a1" } }, { info: { id: "u2" } }, { info: { id: "a2" } }]
  expect(ForkAgents.historyBefore(messages, "a2").map((message) => message.info.id)).toEqual(["u1", "a1", "u2"])
  expect(ForkAgents.historyBefore(messages, "u1")).toEqual([])
  expect(ForkAgents.historyBefore(messages, "missing")).toEqual([])
})

test("forkDirective prepends the preamble to the directive", () => {
  const text = ForkAgents.forkDirective("check the cache")
  expect(text.startsWith(ForkAgents.FORK_PREAMBLE)).toBe(true)
  expect(text).toEndWith("Directive: check the cache")
})

test("inherit can be turned off", () => {
  expect(ForkAgents.inheritEnabled()).toBe(true)
  process.env.OPENCODE_FORK_SUBAGENT_INHERIT = "0"
  expect(ForkAgents.inheritEnabled()).toBe(false)
})
