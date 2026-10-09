import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// FORK-SEAM: fork-api (read-only fork data for the web client, see docs/fork/seams.md)

const Window = Schema.Struct({
  utilization: Schema.Finite,
  reset: Schema.Finite,
  status: Schema.String,
})

const ForkUsageResponse = Schema.Struct({
  turns: Schema.Finite,
  cost: Schema.Finite,
  cacheHit: Schema.optional(Schema.Finite),
  last: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      cost: Schema.Finite,
      cacheHit: Schema.optional(Schema.Finite),
      breakdown: Schema.Struct({
        system: Schema.Finite,
        tools: Schema.Finite,
        history: Schema.Finite,
        tool_output: Schema.Finite,
      }),
    }),
  ),
  children: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      agent: Schema.String,
      model: Schema.String,
      turns: Schema.Finite,
      cost: Schema.Finite,
    }),
  ),
  quota: Schema.optional(
    Schema.Struct({
      provider: Schema.String,
      status: Schema.String,
      time: Schema.Finite,
      fiveHour: Schema.optional(Window),
      sevenDay: Schema.optional(Window),
      windowSpent: Schema.optional(Schema.Finite),
    }),
  ),
  budget: Schema.Struct({
    usd: Schema.optional(Schema.Finite),
    window: Schema.optional(Schema.Finite),
  }),
}).annotate({ identifier: "ForkUsage" })

const ForkSuggestionResponse = Schema.Struct({
  enabled: Schema.Boolean,
  messageID: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
}).annotate({ identifier: "ForkSuggestion" })

export const ForkPaths = {
  usage: "/fork/session/:sessionID/usage",
  suggestion: "/fork/session/:sessionID/suggestion",
} as const

export const ForkApi = HttpApi.make("fork")
  .add(
    HttpApiGroup.make("fork")
      .add(
        HttpApiEndpoint.get("usage", ForkPaths.usage, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ForkUsageResponse, "Session usage"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "fork.session.usage",
            summary: "Get session usage",
            description:
              "Get cost, cache hit ratio, context breakdown, subagent cost, subscription quota and budget for a session and its subagents. Empty when no usage was recorded.",
          }),
        ),
        HttpApiEndpoint.get("suggestion", ForkPaths.suggestion, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ForkSuggestionResponse, "Next prompt suggestion"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "fork.session.suggestion",
            summary: "Get next prompt suggestion",
            description:
              "Get the predicted next user prompt for the session. It belongs to messageID, the last assistant message of the turn that produced it.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "fork",
          description: "Read-only fork data (usage, quota, budget).",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode fork HttpApi",
      version: "0.0.1",
      description: "Fork-only HttpApi routes.",
    }),
  )
