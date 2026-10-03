import { Effect, Stream } from "effect"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { ForkRouteProvider } from "@/provider/fork-route"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"

// One-shot completion on the small model of a provider (title-generator model resolution): `type: "prompt"`
// hooks and the auto-mode permission classifier. `current` picks the provider (default model if missing).
export const smallModelRun = Effect.fn("ForkSmallModel.run")(function* (input: {
  prompt: string
  maxOutputTokens?: number
  // Plain completion for tiny answers: the small model's default thinking would dwarf the answer.
  noThinking?: boolean
  current?: { providerID: string; modelID: string }
}) {
  const llm = yield* LLM.Service
  const provider = yield* Provider.Service
  const agent = {
    name: "fork-small-model",
    mode: "primary" as const,
    permission: [],
    options: {} as Record<string, unknown>,
    native: true,
    prompt: "",
  }
  const chosen = input.current
    ? { providerID: ProviderV2.ID.make(input.current.providerID), modelID: ModelV2.ID.make(input.current.modelID) }
    : yield* provider.defaultModel()
  // A Router model is virtual: its small model is the one of the provider the last routed turn ran on.
  const routed = ForkRouteProvider.concrete({ providerID: chosen.providerID, id: chosen.modelID })
  const fallback = routed
    ? { providerID: ProviderV2.ID.make(routed.providerID), modelID: ModelV2.ID.make(routed.modelID) }
    : chosen
  const model =
    (yield* provider.getSmallModel(fallback.providerID)) ??
    (yield* provider.getModel(fallback.providerID, fallback.modelID))
  if (input.noThinking && model.api.npm === "@ai-sdk/anthropic") agent.options = { thinking: { type: "disabled" } }
  const sessionID = SessionID.descending()
  const events = yield* llm
    .stream({
      agent,
      user: {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
      },
      system: [],
      small: true,
      maxOutputTokens: input.maxOutputTokens,
      tools: {},
      model,
      sessionID,
      retries: 1,
      messages: [{ role: "user", content: input.prompt }],
    })
    .pipe(Stream.runCollect)
  const finish = events.findLast(LLMEvent.is.stepFinish)
  return {
    text: events
      .filter(LLMEvent.is.textDelta)
      .map((part) => part.text)
      .join(""),
    providerID: model.providerID as string,
    modelID: model.id as string,
    cost: finish ? Session.getUsage({ model, usage: finish.usage ?? new Usage({}), metadata: finish.providerMetadata }).cost : 0,
  }
})
