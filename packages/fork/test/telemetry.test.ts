import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import { jsonSchema, tool } from "ai"

process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-telemetry-${process.pid}-${Date.now()}.db`)
const { ForkTelemetry } = await import("../src/telemetry")

const request = {
  agent: "build",
  system: ["unused when system messages are present"],
  messages: [
    { role: "system" as const, content: "s".repeat(100) },
    { role: "user" as const, content: [{ type: "text" as const, text: "u".repeat(50) }] },
    {
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, toolCallId: "1", toolName: "read", input: { path: "a" } }],
    },
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "1",
          toolName: "read",
          output: {
            type: "content" as const,
            value: [
              { type: "text" as const, text: "o".repeat(300) },
              { type: "media" as const, data: "x".repeat(10_000), mediaType: "image/png" },
            ],
          },
        },
      ],
    },
  ],
  tools: {
    read: tool({ description: "d".repeat(20), inputSchema: jsonSchema({ type: "object" }) }),
  },
}

test("measures each category on the final request", async () => {
  const measured = await ForkTelemetry.measureRequest(request)
  expect(measured.chars.system).toBe(100)
  expect(measured.chars.tool_output).toBe(300)
  expect(measured.chars.tools).toBe("read".length + 20 + JSON.stringify({ type: "object" }).length)
  expect(measured.chars.history).toBeGreaterThan(50)
  expect(measured.media_count).toBe(1)
  expect(measured.message_count).toBe(3)
})

test("allocates billed input tokens proportionally", () => {
  expect(ForkTelemetry.allocate(1000, { system: 100, tools: 100, history: 200, tool_output: 600 })).toEqual({
    system: 100,
    tools: 100,
    history: 200,
    tool_output: 600,
  })
  expect(ForkTelemetry.allocate(1000, { system: 0, tools: 0, history: 0, tool_output: 0 }).system).toBe(0)
})

test("records a turn and walks subagent sessions", async () => {
  const usage = (sessionID: string, messageID: string) => ({
    sessionID,
    messageID,
    providerID: "anthropic",
    modelID: "claude",
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 800, write: 100 } },
    cost: 0.01,
  })
  ForkTelemetry.measure("parent", request)
  await ForkTelemetry.record(usage("parent", "m1"))
  ForkTelemetry.measure("child", { ...request, agent: "explore", parentSessionID: "parent" })
  await ForkTelemetry.record(usage("child", "m2"))

  const own = ForkTelemetry.steps("parent")
  expect(own).toHaveLength(1)
  expect(own[0].agent).toBe("build")
  expect(own[0].est_system + own[0].est_tools + own[0].est_history + own[0].est_tool_output).toBeCloseTo(1000, -1)

  const tree = ForkTelemetry.steps("parent", { children: true })
  expect(tree.map((step) => step.agent)).toEqual(["build", "explore"])
  const recent = ForkTelemetry.recentSessions(50).map((row) => row.session_id)
  expect(recent).toContain("parent")
  expect(recent).not.toContain("child")
})

test("a turn without a measurement is still recorded", async () => {
  await ForkTelemetry.record({
    sessionID: "unmeasured",
    messageID: "m3",
    providerID: "openai",
    modelID: "gpt",
    tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  })
  expect(ForkTelemetry.steps("unmeasured")[0].agent).toBe("unknown")
})
