// FORK-SEAM: background-shell
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { PositiveInt } from "@opencode-ai/core/schema"
import { ForkShell } from "@opencode-fork/core/shell"

const OutputParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "Job id returned by a background bash command" }),
  lines: Schema.optional(PositiveInt).annotate({ description: "Number of trailing lines to return (default 50)" }),
})

const KillParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "Job id returned by a background bash command" }),
})

const find = Effect.fn("ShellBackground.find")(function* (
  background: BackgroundJob.Interface,
  id: string,
  ctx: Tool.Context,
) {
  const job = yield* background.get(id)
  if (!job || job.type !== ForkShell.JOB_TYPE || job.metadata?.sessionId !== ctx.sessionID) return
  return job
})

export const ShellOutputTool = Tool.define(
  "shell_output",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    return {
      description:
        "Read the status and the latest output lines of a background bash command started with background=true. Returns the status, the exit code once finished and the last lines of the output.",
      parameters: OutputParameters,
      execute: (params: Schema.Schema.Type<typeof OutputParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const job = yield* find(background, params.id, ctx)
          if (!job) return { title: params.id, metadata: {}, output: `No background shell job ${params.id}.` }
          const file = String(job.metadata?.outputPath)
          const text = yield* Effect.promise(() => Bun.file(file).slice(-262144).text())
          const exit = job.status === "completed" ? ForkShell.parseResult(job.output ?? "").exit : null
          return {
            title: params.id,
            metadata: {},
            output: [
              `status: ${job.status}`,
              ...(exit === null ? [] : [`exit: ${exit}`]),
              `output file: ${file}`,
              "",
              ForkShell.tail(text, params.lines ?? 50) || "(no output yet)",
            ].join("\n"),
          }
        }),
    }
  }),
)

export const ShellKillTool = Tool.define(
  "shell_kill",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    return {
      description: "Stop a running background bash command started with background=true.",
      parameters: KillParameters,
      execute: (params: Schema.Schema.Type<typeof KillParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const job = yield* find(background, params.id, ctx)
          if (!job) return { title: params.id, metadata: {}, output: `No background shell job ${params.id}.` }
          if (job.status !== "running")
            return { title: params.id, metadata: {}, output: `Job ${params.id} already ${job.status}.` }
          yield* background.cancel(params.id)
          return { title: params.id, metadata: {}, output: `Job ${params.id} stopped.` }
        }),
    }
  }),
)
