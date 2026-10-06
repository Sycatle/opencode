// Fork: a session schedules its own wakeup with schedule_wakeup; once due, the idle session receives it as a
// synthetic user message and the model answers.
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { ForkWakeup } from "@opencode-fork/core/wakeup"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const config = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const setup = (directory: string, url: string) =>
  Effect.promise(() =>
    Bun.write(
      path.join(directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config(url) }),
    ),
  )

const synthetic = (sessionID: SessionID, reply: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const messages = yield* sessions.messages({ sessionID })
      const woken = messages.find((item) =>
        item.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("<scheduled-wakeup")),
      )
      const answered = messages.findLast(
        (item) =>
          item.info.role === "assistant" && item.parts.some((part) => part.type === "text" && part.text === reply),
      )
      return woken && answered ? woken : undefined
    }),
    "the session was never woken",
  )

it.instance(
  "a scheduled wakeup is injected into the idle session, then the model answers",
  () =>
    Effect.gen(function* () {
      process.env.OPENCODE_FORK_MESSAGING_POLL_MS = "100"
      process.env.OPENCODE_FORK_WAKEUP_MIN_SECONDS = "1"
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* setup(directory, llm.url)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Waiter",
        permission: [{ permission: "*", pattern: "*", action: "allow" as const }],
      })

      // schedule_wakeup is deferred: the model loads it through deferred_tool_search first.
      yield* llm.tool("deferred_tool_search", { query: "select:schedule_wakeup" })
      yield* llm.tool("schedule_wakeup", { delaySeconds: 1, prompt: "check the build", reason: "waiting for CI" })
      yield* llm.text("scheduled")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("<scheduled-wakeup"), "woken up")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "wait for CI" }] })
      expect(ForkWakeup.get(session.id)?.prompt).toBe("check the build")

      const woken = yield* synthetic(session.id, "woken up")
      const text = woken.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      expect(text).toContain('reason="waiting for CI"')
      expect(text).toContain("check the build")
      expect(text).toContain("not the user")
      expect(woken.info.role).toBe("user")
      expect((woken.info as SessionV1.User).agent).toBe("build")
      expect(ForkWakeup.get(session.id)).toBeUndefined()
    }),
  30_000,
)

it.instance(
  "an overdue wakeup persisted in fork.db is delivered right away",
  () =>
    Effect.gen(function* () {
      process.env.OPENCODE_FORK_MESSAGING_POLL_MS = "100"
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* setup(directory, llm.url)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Resumed" })

      yield* llm.text("first turn")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start" }] })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("<scheduled-wakeup"), "caught up")
      ForkWakeup.set({ sessionID: session.id, due: Date.now() - 60_000, prompt: "catch up", reason: "missed" })

      yield* synthetic(session.id, "caught up")
      expect(ForkWakeup.get(session.id)).toBeUndefined()
    }),
  30_000,
)

it.instance(
  "/loop with an interval arms a repeating wakeup and runs the prompt now",
  () =>
    Effect.gen(function* () {
      process.env.OPENCODE_FORK_MESSAGING_POLL_MS = "100"
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* setup(directory, llm.url)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Looper" })

      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("repeats every 10 min"), "looping")
      yield* prompt.command({
        sessionID: session.id,
        command: "loop",
        arguments: "10m poll the deploy",
        agent: "build",
      })
      expect(ForkWakeup.get(session.id)).toMatchObject({ prompt: "poll the deploy", every: 600_000 })
      ForkWakeup.cancel(session.id)

      // Without an interval the model paces itself: nothing is armed.
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("dynamic loop"), "paced")
      yield* prompt.command({ sessionID: session.id, command: "loop", arguments: "poll the deploy", agent: "build" })
      expect(ForkWakeup.get(session.id)).toBeUndefined()
    }),
  30_000,
)
