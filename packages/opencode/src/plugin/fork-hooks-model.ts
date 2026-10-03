import type { ForkHooks } from "@opencode-fork/core/hooks"

// One-shot completion on the small model of the session's provider, for `type: "prompt"` hooks.
// The plugin has no Effect services, so it goes through AppRuntime scoped to the project directory
// (same model resolution as the title and project-copy-name generators).
export function smallModelAsk(
  directory: string,
  session: (sessionID: string | undefined) => { providerID: string; modelID: string } | undefined,
): ForkHooks.Ask {
  return async (prompt, event) => {
    const { Effect, Stream } = await import("effect")
    const { LLMEvent } = await import("@opencode-ai/llm")
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { InstanceStore } = await import("@/project/instance-store")
    const { Provider } = await import("@/provider/provider")
    const { LLM } = await import("@/session/llm")
    const { MessageID, SessionID } = await import("@/session/schema")
    const { ProviderV2 } = await import("@opencode-ai/core/provider")
    const { ModelV2 } = await import("@opencode-ai/core/model")

    const agent = {
      name: "fork-prompt-hook",
      mode: "primary" as const,
      permission: [],
      options: {},
      native: true,
      prompt: "",
    }
    const current = session(event.sessionID)

    return AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory },
          Effect.gen(function* () {
            const llm = yield* LLM.Service
            const provider = yield* Provider.Service
            const fallback = current
              ? { providerID: ProviderV2.ID.make(current.providerID), modelID: ModelV2.ID.make(current.modelID) }
              : yield* provider.defaultModel()
            const model =
              (yield* provider.getSmallModel(fallback.providerID)) ??
              (yield* provider.getModel(fallback.providerID, fallback.modelID))
            const sessionID = SessionID.descending()
            return yield* llm
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
                tools: {},
                model,
                sessionID,
                retries: 1,
                messages: [{ role: "user", content: prompt }],
              })
              .pipe(
                Stream.filter(LLMEvent.is.textDelta),
                Stream.map((part) => part.text),
                Stream.mkString,
              )
          }),
        ),
      ),
    )
  }
}
