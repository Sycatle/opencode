// Fork: a router/auto session resolves each new message to a concrete model through the Router (small-model
// signals, tier choice, journal) and reroutes a turn whose model fails before streaming anything.
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { ForkRouteLog } from "@opencode-fork/core/route-log"
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
import { testEffect } from "../lib/effect"
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

const model = (id: string, output: number) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2026-06-01",
  limit: { context: 200_000, output: 10_000 },
  cost: { input: output / 5, output, cache_read: output / 50, cache_write: output / 4 },
  options: {},
})

// Two tiers: a fast model (output $4/M) and a standard one ($10/M).
const config = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: { "quick-model": model("quick-model", 4), "solid-model": model("solid-model", 10) },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const run = (url: string) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config(url) })),
    )
    const sessions = yield* Session.Service
    return yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" as const }] })
  })

// The Router's classification request, told apart from the turn and the title by its prompt.
const classifying = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("request classifier")
const trivial = JSON.stringify({
  task_type: "small_edit",
  complexity: 0.1,
  reasoning: 0.05,
  tool_intensity: 0.1,
  latency_sensitivity: 0.5,
  ambiguity: 0,
  confidence: 0.95,
})
const auto = { providerID: "router", modelID: "auto" } as never

it.instance("router/auto classifies a new message and runs it on the concrete model of the chosen tier", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const session = yield* run(llm.url)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service

    yield* llm.textMatch(classifying, trivial)
    yield* llm.text("renamed")
    yield* prompt.prompt({ sessionID: session.id, model: auto, parts: [{ type: "text", text: "rename foo to bar" }] })

    const row = ForkRouteLog.latest(session.id)
    expect(row).toMatchObject({ kind: "decision", tier: "fast", provider_id: "test", model_id: "quick-model" })
    const answer = (yield* sessions.messages({ sessionID: session.id })).findLast((item) => item.info.role === "assistant")
    expect(answer?.info).toMatchObject({ providerID: "test", modelID: "quick-model" })
  }),
  30_000,
)

it.instance("a routed model that fails before streaming hands the turn to another candidate", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const session = yield* run(llm.url)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service

    yield* llm.textMatch(classifying, trivial)
    yield* llm.error(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
    yield* llm.text("renamed anyway")
    yield* prompt.prompt({ sessionID: session.id, model: auto, parts: [{ type: "text", text: "rename foo to bar" }] })

    const row = ForkRouteLog.latest(session.id)
    expect(row).toMatchObject({ kind: "fallback", provider_id: "test", model_id: "solid-model" })
    const answers = (yield* sessions.messages({ sessionID: session.id })).filter((item) => item.info.role === "assistant")
    // The failed attempt streamed nothing: it is removed rather than kept as an error message.
    expect(answers.map((item) => item.info.role === "assistant" && item.info.modelID)).toEqual(["solid-model"])
  }),
  30_000,
)
