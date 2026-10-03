// Fork: smart compaction. A session whose todo list finishes above the threshold is compacted at the end of the
// turn, through the existing compaction path (the cached summary replays the last request); one that is still in a
// tool loop, or whose task is open, is not.
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { ForkCompactionLog } from "@opencode-fork/core/compaction-log"
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
import { reply, TestLLMServer } from "../lib/llm-server"
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
          limit: { context: 1_000_000, output: 10000 },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const todo = (status: string) => ({ todos: [{ content: "ship it", status, priority: "high" }] })

const summaryText = `## Objective\n- ${"keep going ".repeat(30)}\n\n## Next Move\n1. (none)`

const run = (url: string) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config(url) })),
    )
    const sessions = yield* Session.Service
    return yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" as const }] })
  })

it.instance("a session whose todo finishes above the threshold is compacted at the end of the turn", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const session = yield* run(llm.url)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service

    // The first request sets the stable prefix. Mid-loop the context is then at 60% of the window: nothing may
    // compact there, only the end of the turn decides.
    yield* llm.push(reply().tool("todowrite", todo("in_progress")).usage({ input: 5_000, output: 10 }))
    yield* llm.push(reply().tool("todowrite", todo("completed")).usage({ input: 600_000, output: 10 }))
    yield* llm.text("all done", { usage: { input: 600_100, output: 100 } })
    // The summary request of the existing compaction path.
    yield* llm.text(summaryText)
    yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do the thing" }] })

    const messages = yield* sessions.messages({ sessionID: session.id })
    const summaries = messages.filter((item) => item.info.role === "assistant" && item.info.summary)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].parts.some((part) => part.type === "text" && part.text.includes("keep going"))).toBe(true)
    expect(messages.some((item) => item.parts.some((part) => part.type === "compaction"))).toBe(true)
    expect(messages.filter((item) => item.info.role === "assistant" && !item.info.summary)).toHaveLength(3)

    const rows = ForkCompactionLog.list(session.id)
    expect(rows.map((row) => [row.phase, row.compact, row.code])).toEqual([["end", 1, "boundary"]])
  }),
  30_000,
)

it.instance("a session in a tool loop, or with an open task, is not compacted", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const session = yield* run(llm.url)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service

    yield* llm.push(reply().tool("todowrite", todo("in_progress")).usage({ input: 5_000, output: 10 }))
    yield* llm.push(reply().tool("todowrite", todo("in_progress")).usage({ input: 600_000, output: 10 }))
    yield* llm.text("paused", { usage: { input: 600_100, output: 100 } })
    yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do the thing" }] })

    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(messages.some((item) => item.info.role === "assistant" && item.info.summary)).toBe(false)
    expect(messages.filter((item) => item.info.role === "assistant")).toHaveLength(3)
    // The tool step above the threshold was never a decision point: only the end of the turn is.
    expect(ForkCompactionLog.list(session.id).map((row) => [row.phase, row.compact, row.code])).toEqual([
      ["end", 0, "task-open"],
    ])
  }),
  30_000,
)
