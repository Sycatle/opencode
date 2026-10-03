import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ForkClaudeTools } from "@opencode-fork/core/claude-tools"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { ForkRouteProvider } from "@/provider/fork-route"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
const router = ProviderV2.ID.make("router")

afterEach(async () => {
  delete process.env.OPENCODE_FORK_ROUTE
  await disposeAllInstances()
})

it.instance(
  "router/* models appear in the provider list next to a connected provider",
  Effect.gen(function* () {
    const providers = yield* Provider.use.list()
    const virtual = providers[router]
    expect(Object.keys(virtual.models).toSorted()).toEqual(["auto", "fast", "frontier", "reasoning", "standard"])
    expect(virtual.name).toBe("Router")
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
  }),
  { config: { provider: { anthropic: { options: { apiKey: "test-key" } } } } },
)

it.instance(
  "no router provider without a connected provider, or when disabled",
  Effect.gen(function* () {
    expect((yield* Provider.use.list())[router]).toBeUndefined()
  }),
  { config: { disabled_providers: ["router", "anthropic"] } },
)

it.instance(
  "a virtual model runs on the concrete model its turn resolved to",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const virtual = yield* provider.getModel(router, ModelV2.ID.make("auto"))
    ForkRouteProvider.remember("auto", { providerID: "anthropic", modelID: "claude-haiku-4-5" })
    const language = yield* provider.getLanguage(virtual)
    expect(language.modelId).toBe("claude-haiku-4-5")
    expect(language.provider).toContain("anthropic")
  }),
  { config: { provider: { anthropic: { options: { apiKey: "test-key" } } } } },
)

it.instance(
  "the Claude Code tool profile follows the concrete provider, never the router",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const virtual = yield* provider.getModel(router, ModelV2.ID.make("auto"))
    const claude = yield* provider.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-haiku-4-5"))
    expect(ForkClaudeTools.enabled(virtual)).toBe(false)
    expect(ForkClaudeTools.enabled(claude)).toBe(true)
    expect(ForkClaudeTools.enabled({ providerID: "openai" })).toBe(false)
  }),
  { config: { provider: { anthropic: { options: { apiKey: "test-key" } } } } },
)
