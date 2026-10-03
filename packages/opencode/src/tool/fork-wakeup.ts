// FORK-SEAM: wakeups
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ForkWakeup } from "@opencode-fork/core/wakeup"

const Parameters = Schema.Struct({
  delaySeconds: Schema.optional(Schema.Number).annotate({
    description: "Seconds until the wakeup, between 60 and 3600 (other values are clamped). Required unless stop is true.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "Prompt injected into this session when the wakeup fires. Required unless stop is true.",
  }),
  reason: Schema.optional(Schema.String).annotate({ description: "One short sentence on why you are waiting" }),
  stop: Schema.optional(Schema.Boolean).annotate({ description: "Cancel the pending wakeup instead of scheduling one" }),
})

export const ScheduleWakeupTool = Tool.define(
  "schedule_wakeup",
  Effect.succeed({
    description:
      "Schedule this session to wake itself up later: after delaySeconds (60 to 3600) the prompt is injected as a message marked as a scheduled wakeup, not from the user. Use it to wait for something (a deploy, a CI run, a long job) or to pace a loop without polling. Only one wakeup is pending per session: a new call replaces the previous one, and stop: true cancels it. It fires only while opencode is running on this session (a session resumed later receives it then); a busy session gets it after its current turn.",
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.sync(() => {
        const plan = ForkWakeup.plan(params)
        if (!plan.ok) return { title: "schedule_wakeup", metadata: {}, output: plan.error }
        if (plan.stop) {
          const had = ForkWakeup.cancel(ctx.sessionID)
          return {
            title: "wakeup stopped",
            metadata: {},
            output: had ? "The pending wakeup was cancelled." : "No wakeup was pending.",
          }
        }
        ForkWakeup.set({ sessionID: ctx.sessionID, due: plan.due, prompt: plan.prompt, reason: plan.reason })
        return {
          title: `wakeup in ${ForkWakeup.formatDuration(plan.delaySeconds * 1000)}`,
          metadata: {},
          output: `Wakeup scheduled in ${plan.delaySeconds} s${plan.clamped ? " (clamped to the allowed range)" : ""}. It replaces any previous one.`,
        }
      }),
  }),
)
