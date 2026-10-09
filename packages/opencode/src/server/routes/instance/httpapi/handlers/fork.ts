import { ForkBudget } from "@opencode-fork/core/budget"
import { ForkPromptSuggestion } from "@opencode-fork/core/prompt-suggestion"
import { ForkQuota } from "@opencode-fork/core/quota"
import { ForkSummary } from "@opencode-fork/core/summary"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

// FORK-SEAM: fork-api

export const forkHandlers = HttpApiBuilder.group(InstanceHttpApi, "fork", (handlers) =>
  Effect.succeed(
    handlers
      .handle("suggestion", (ctx) =>
        Effect.sync(() => {
          const enabled = ForkPromptSuggestion.enabled() && ForkPromptSuggestion.userEnabled()
          const row = enabled ? ForkPromptSuggestion.latest(ctx.params.sessionID) : undefined
          return { enabled, messageID: row?.message_id, text: row?.text ?? undefined }
        }),
      )
      .handle("usage", (ctx) =>
        Effect.sync(() => {
          const steps = ForkTelemetry.steps(ctx.params.sessionID, { children: true })
          const summary = ForkSummary.summarize(steps, ctx.params.sessionID)
          // The quota belongs to the provider of the latest turn; a session without telemetry has none.
          const provider = steps.findLast((step) => step.session_id === ctx.params.sessionID)?.provider_id
          const snapshot = provider ? ForkQuota.fresh(provider) : undefined
          return {
            ...summary,
            quota: snapshot && {
              provider: snapshot.provider,
              status: snapshot.status,
              time: snapshot.time,
              fiveHour: snapshot.five_hour,
              sevenDay: snapshot.seven_day,
              windowSpent: ForkQuota.windowSpent(ctx.params.sessionID, snapshot.provider),
            },
            budget: { usd: ForkBudget.limit(), window: ForkBudget.windowLimit() },
          }
        }),
      ),
  ),
)
