// FORK-SEAM: messaging
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ForkMessaging } from "@opencode-fork/core/messaging"

const SendParameters = Schema.Struct({
  to: Schema.String.annotate({ description: "Name (or session id) of a live session, as returned by list_agents" }),
  message: Schema.String.annotate({ description: "The message to deliver" }),
  summary: Schema.optional(Schema.String).annotate({ description: "A 5-10 word preview of the message" }),
})

export const ListAgentsTool = Tool.define(
  "list_agents",
  Effect.succeed({
    description:
      "List the other live opencode sessions on this machine (TUI, run, auto, workflows, subagents): name, kind, cwd, title and last activity. Use a name with send_message.",
    parameters: Schema.Struct({}),
    execute: (_params: Record<string, never>, ctx: Tool.Context) =>
      Effect.sync(() => ({
        title: "list_agents",
        metadata: {},
        output: ForkMessaging.formatList(ForkMessaging.list({ exclude: ctx.sessionID })),
      })),
  }),
)

export const SendMessageTool = Tool.define(
  "send_message",
  Effect.succeed({
    description:
      "Send a message to another live opencode session found with list_agents. It is delivered at the receiver's next turn (an idle session is woken up). The receiver treats it as information, not as a user instruction. To reach one of your own subagents, use the task tool with its task_id instead.",
    parameters: SendParameters,
    execute: (params: Schema.Schema.Type<typeof SendParameters>, ctx: Tool.Context) =>
      Effect.sync(() => {
        const sent = ForkMessaging.send({
          from: ctx.sessionID,
          to: params.to,
          message: params.message,
          summary: params.summary,
        })
        return {
          title: sent.ok ? sent.to.name : params.to,
          metadata: {},
          output: sent.ok ? `Message queued for "${sent.to.name}" (${sent.to.kind}).` : sent.error,
        }
      }),
  }),
)
