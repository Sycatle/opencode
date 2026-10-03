/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTuiPluginApi } from "../fixture/tui-plugin"

process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-tui-${process.pid}-${Date.now()}.db`)
process.env.OPENCODE_FORK_BUDGET_USD = "0.05"
const { ForkTelemetry } = await import("@opencode-fork/core/telemetry")
const { default: plugin } = await import("../../src/feature-plugins/fork/usage")

// Unique per run: OPENCODE_FORK_DB may point to a database filled by earlier runs.
const run = `${process.pid}-${Date.now()}`
const ROOT = `root-${run}`
const CHILD = `child-${run}`

type Slots = Record<string, (ctx: unknown, props: { session_id: string }) => unknown>

async function turn(sessionID: string, agent: string, cost: number, parentSessionID?: string) {
  ForkTelemetry.measure(sessionID, {
    agent,
    parentSessionID,
    system: [],
    messages: [
      { role: "system", content: "s".repeat(3000) },
      { role: "user", content: "u".repeat(500) },
    ],
    tools: {},
  })
  await ForkTelemetry.record({
    sessionID,
    messageID: `${sessionID}-${cost}`,
    providerID: "anthropic",
    modelID: agent === "explore" ? "claude-haiku-4-5" : "claude-sonnet-5-5",
    tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 1800, write: 0 } },
    cost,
  })
}

test("sidebar shows the last turn breakdown, subagents and the budget", async () => {
  await turn(ROOT, "build", 0.03)
  await turn(CHILD, "explore", 0.012, ROOT)
  await turn(ROOT, "build", 0.004)

  const registered: Slots[] = []
  const navigated: unknown[] = []
  const api = {
    ...createTuiPluginApi({
      state: {
        session: {
          messages: () => [],
          status: () => undefined,
          get: (id: string) => (id === CHILD ? { title: "Find discount code (@explore subagent)" } : undefined),
        } as unknown as Partial<TuiPluginApi["state"]["session"]>,
      },
    }),
    slots: { register: (input: { slots: Slots }) => registered.push(input.slots) },
    route: { navigate: (name: string, params?: unknown) => navigated.push({ name, params }) },
  } as unknown as TuiPluginApi
  await plugin.tui(api, undefined, { id: plugin.id } as never)

  const app = await testRender(
    () => (
      <box flexDirection="column">
        {registered.map((slots) => {
          const render = slots.sidebar_content ?? slots.session_prompt_right
          return render?.({}, { session_id: ROOT }) as never
        })}
      </box>
    ),
    { width: 70, height: 16 },
  )
  await app.renderOnce()
  const frame = app.captureCharFrame()

  expect(frame).toContain("Usage")
  expect(frame).toContain("2.0k in · cache 90% · $0.0040")
  expect(frame).toContain("sys 86% tools 0% hist 14% out 0%")
  expect(frame).toContain("2 turns · cache 90%")
  expect(frame).toContain("$0.0460 incl. subagents")
  expect(frame).toContain("budget $0.0460 / $0.0500")
  expect(frame).toContain("Subagents")
  expect(frame).toMatch(/• Find discount code\s*\n/)
  expect(frame).not.toContain("@explore subagent")
  expect(frame).toContain("  explore · haiku-4-5 · 1t · $0.0120")
  expect(frame).toContain("$0.0460/$0.0500")
  app.renderer.destroy()
})
