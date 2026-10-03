// FORK-SEAM: workflow-tool
import { appendFileSync, closeSync, openSync } from "fs"
import path from "path"
import { Effect, Schema, Scope } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { ForkAgents } from "@opencode-fork/core/agents"
import { ForkAutonomy } from "@opencode-fork/core/autonomy"
import { ForkShell } from "@opencode-fork/core/shell"
import { ForkWorkflow } from "@opencode-fork/core/workflow"
import type { TaskPromptOps } from "./task"

export const Parameters = Schema.Struct({
  script: Schema.optional(Schema.String).annotate({
    description:
      "Inline workflow source. It must begin with `export const meta = { name, description }` (a pure literal) and export a default async function. It is saved and its path returned.",
  }),
  scriptPath: Schema.optional(Schema.String).annotate({
    description: "Path of a workflow script to run (relative to the project), e.g. one saved by an earlier inline call.",
  }),
  args: Schema.optional(Schema.Unknown).annotate({ description: "JSON value passed to the script as `args`." }),
  resumeFromRunId: Schema.optional(Schema.String).annotate({
    description: "Id of an interrupted or failed run to continue; its finished agent calls are not run again.",
  }),
})

export const WorkflowTool = Tool.define(
  "workflow",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const resumed = params.resumeFromRunId ? ForkWorkflow.getRun(params.resumeFromRunId) : undefined
          if (params.resumeFromRunId && !resumed)
            return yield* Effect.fail(new Error(`Unknown run id ${params.resumeFromRunId}`))
          if (resumed?.status === "running") return yield* Effect.fail(new Error(`Run ${resumed.id} is still running`))
          if (params.script !== undefined && params.scriptPath !== undefined)
            return yield* Effect.fail(new Error("Give either script or scriptPath, not both"))
          const scriptPath = params.scriptPath ?? resumed?.script
          if (params.script === undefined && scriptPath === undefined)
            return yield* Effect.fail(new Error("Give script, scriptPath or resumeFromRunId"))

          const source = yield* Effect.tryPromise(async () => {
            if (params.script !== undefined) return ForkWorkflow.writeScript(params.script)
            const file = path.resolve(instance.directory, scriptPath ?? "")
            const meta = await ForkWorkflow.readMeta(file)
            if (!meta.ok) throw new Error(meta.message)
            return { path: file, meta: meta.meta }
          })

          const running = (yield* background.list()).filter(
            (job) => job.type === ForkWorkflow.JOB_TYPE && job.status === "running",
          ).length
          if (running >= ForkAgents.maxBackground())
            return yield* Effect.fail(
              new Error(
                `${running} workflows are already running (limit ${ForkAgents.maxBackground()}). Wait for one to finish or stop it.`,
              ),
            )
          const budget = ForkWorkflow.remainingBudget(ctx.sessionID)
          if (budget === 0) return yield* Effect.fail(new Error("The session budget is spent; no workflow can start"))

          yield* ctx.ask({
            permission: "workflow",
            patterns: [source.meta.name],
            always: ["*"],
            metadata: { name: source.meta.name, description: source.meta.description, script: source.path },
          })

          const runID = resumed?.id ?? ForkWorkflow.newRunID()
          const log = path.join(ForkWorkflow.scriptsDir(), `${runID}.log`)
          // Tests substitute the child; production re-invokes this entrypoint.
          const launcher = (ctx.extra?.workflowCommand as string[] | undefined) ?? [
            ...ForkAutonomy.selfCommand(process.execPath, process.argv, process.execArgv),
            "workflow",
            "run",
          ]
          const command = [
            ...launcher,
            source.path,
            "--dir",
            instance.directory,
            ...(resumed ? ["--resume", runID] : ["--id", runID]),
            ...(params.args === undefined ? [] : ["--args", JSON.stringify(params.args)]),
            ...(budget === undefined ? [] : ["--budget", String(budget)]),
          ]

          // Recorded before the child starts, so the run is visible and cannot be resumed twice at once.
          ForkWorkflow.startRun(runID, source.path, source.meta.name)
          const job = yield* background.start({
            type: ForkWorkflow.JOB_TYPE,
            title: source.meta.name,
            // sessionId lets Session.remove cancel the job through cancelBackgroundJobs.
            metadata: {
              sessionId: ctx.sessionID,
              outputPath: log,
              runId: runID,
              name: source.meta.name,
              script: source.path,
            },
            run: Effect.acquireUseRelease(
              Effect.sync(() => {
                appendFileSync(log, `$ ${command.join(" ")}\n`)
                const fd = openSync(log, "a")
                return { fd, proc: Bun.spawn(command, { cwd: instance.directory, stdout: "pipe", stderr: fd }) }
              }),
              (child) =>
                Effect.promise(async () => ({
                  out: await new Response(child.proc.stdout).text(),
                  code: await child.proc.exited,
                })).pipe(
                  Effect.flatMap((result) =>
                    result.code === 0
                      ? Effect.succeed(result.out)
                      : Effect.promise(() => Bun.file(log).slice(-8192).text()).pipe(
                          Effect.flatMap((text) =>
                            Effect.fail(new Error(`workflow exited with code ${result.code}\n${ForkShell.tail(text, 15)}`)),
                          ),
                        ),
                  ),
                ),
              // Runs on completion and on interruption: TaskStop / shell_kill end up here and SIGTERM the run.
              (child) =>
                Effect.sync(() => {
                  child.proc.kill()
                  closeSync(child.fd)
                }),
            ),
          })

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          const inject = Effect.fn("WorkflowTool.inject")(function* (state: "completed" | "error", result: string) {
            if (!ops) return
            yield* ops
              .prompt({
                sessionID: ctx.sessionID,
                agent: ctx.agent,
                parts: [
                  {
                    type: "text",
                    synthetic: true,
                    text: ForkWorkflow.renderMessage({
                      runID,
                      name: source.meta.name,
                      state,
                      result,
                      cost: ForkWorkflow.getRun(runID)?.cost ?? 0,
                      script: source.path,
                    }),
                  },
                ],
              })
              .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
          })
          // Stopped runs (TaskStop, session close) end as "cancelled" and stay silent.
          yield* background.wait({ id: job.id }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                // A child killed before it could say so leaves the run marked running.
                if (result.info?.status !== "completed" && ForkWorkflow.getRun(runID)?.status === "running")
                  ForkWorkflow.finishRun(runID, result.info?.status === "cancelled" ? "interrupted" : "failed")
              }),
            ),
            Effect.flatMap((result) => {
              if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
              if (result.info?.status === "error") return inject("error", result.info.error ?? "")
              return Effect.void
            }),
            Effect.forkIn(scope, { startImmediately: true }),
          )

          return {
            title: source.meta.name,
            metadata: { runId: runID, jobId: job.id, script: source.path, outputPath: log },
            output: ForkWorkflow.startedMessage({
              runID,
              jobID: job.id,
              script: source.path,
              log,
              resumed: resumed !== undefined,
            }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
