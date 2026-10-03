// FORK-SEAM: monitor
import { Effect, Schema, Scope } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { PositiveInt } from "@opencode-ai/core/schema"
import { ForkMonitor } from "@opencode-fork/core/monitor"
import { ForkShell } from "@opencode-fork/core/shell"
import { find } from "./shell-background"
import { ShellTool } from "./shell"
import type { TaskPromptOps } from "./task"

const Parameters = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({ description: "Background bash job id to watch" }),
  command: Schema.optional(Schema.String).annotate({
    description: "Shell command re-run every interval_ms until it exits with code 0",
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "Regex matched against each new output line of job id (until: match)",
  }),
  until: Schema.optional(Schema.Literals(["match", "exit", "success"])).annotate({
    description: 'Condition to wait for. Default: "match" with pattern, "exit" with id, "success" with command',
  }),
  interval_ms: Schema.optional(PositiveInt).annotate({
    description: `Delay between command runs (default ${ForkMonitor.DEFAULT_INTERVAL_MS}, min ${ForkMonitor.MIN_INTERVAL_MS})`,
  }),
  timeout_ms: Schema.optional(PositiveInt).annotate({
    description: `Give up after this many ms (default ${ForkMonitor.DEFAULT_TIMEOUT_MS}, max ${ForkMonitor.MAX_TIMEOUT_MS})`,
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Return immediately and be notified when the condition fires or times out (default false)",
  }),
})

export const MonitorTool = Tool.define(
  "monitor",
  Effect.gen(function* () {
    const shellTool = yield* ShellTool
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope

    const watch = Effect.fn("MonitorTool.watch")(function* (
      options: ForkMonitor.Options,
      ctx: Tool.Context,
      bash: Effect.Success<ReturnType<typeof shellTool.init>>,
    ) {
      const file = options.id ? String((yield* find(background, options.id, ctx))?.metadata?.outputPath) : undefined
      const decoder = new TextDecoder()
      const state = {
        offset: file ? Bun.file(file).size : 0,
        feed: ForkMonitor.emptyFeed,
        attempts: 0,
        lastAttempt: 0,
        lastExit: undefined as number | null | undefined,
        text: "",
      }
      const tailOf = (path: string | undefined) =>
        path ? Effect.promise(() => Bun.file(path).slice(-65536).text()) : Effect.succeed("")
      const commandMode = options.command !== undefined && options.until === "success"

      const step: Effect.Effect<ForkMonitor.Outcome> = Effect.gen(function* () {
        const job = options.id ? yield* background.get(options.id) : undefined
        const ended = options.id ? job?.status !== "running" : false

        if (file && options.pattern && options.until === "match") {
          const size = Bun.file(file).size
          if (size > state.offset) {
            const bytes = yield* Effect.promise(() => Bun.file(file).slice(state.offset, size).arrayBuffer())
            state.offset = size
            const next = ForkMonitor.feed(state.feed, decoder.decode(bytes, { stream: true }), options.pattern)
            state.feed = next.state
            if (next.hit) return { kind: "match" as const, hit: next.hit }
          }
        }

        if (options.command && commandMode && Date.now() - state.lastAttempt >= options.intervalMs) {
          // The bash tool owns parsing, permissions (incl. external_directory), shell.env and truncation.
          const result = yield* bash.execute({ command: options.command, timeout: options.timeoutMs }, ctx)
          state.attempts++
          state.lastAttempt = Date.now()
          state.lastExit = (result.metadata as { exit?: number | null }).exit ?? null
          state.text = result.output
        }

        const verdict = ForkMonitor.decide({
          until: options.until,
          hasCommand: commandMode,
          jobEnded: ended,
          commandExit: state.lastExit,
        })
        if (verdict === "success") return { kind: "success" as const, attempts: state.attempts, tail: state.text }
        if (verdict === "exit") {
          const parsed = job?.status === "completed" ? ForkShell.parseResult(job.output ?? "") : undefined
          return {
            kind: "exit" as const,
            exit: parsed?.exit ?? null,
            tail: yield* tailOf(file),
            error: job?.status === "error" ? (job.error ?? "error") : job?.status === "cancelled" ? "cancelled" : undefined,
          }
        }
        yield* Effect.sleep(`${ForkMonitor.POLL_MS} millis`)
        return yield* step
      })

      return yield* step.pipe(
        Effect.timeoutOption(`${options.timeoutMs} millis`),
        Effect.map(
          (outcome): ForkMonitor.Outcome =>
            outcome._tag === "Some"
              ? outcome.value
              : { kind: "timeout", timeoutMs: options.timeoutMs, attempts: state.attempts, lastExit: state.lastExit },
        ),
      )
    })

    return {
      description: ForkMonitor.DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const title = params.id ?? params.command ?? "monitor"
          const reply = (output: string) => ({ title, metadata: {}, output })
          const options = ForkMonitor.normalize(params)
          if (typeof options === "string") return reply(options)
          if (options.id && !(yield* find(background, options.id, ctx)))
            return reply(`No background shell job ${options.id}.`)

          const bash = yield* shellTool.init()
          if (options.background) {
            const running = (yield* background.list()).filter(
              (job) => job.type === ForkMonitor.JOB_TYPE && job.status === "running",
            ).length
            if (ForkShell.atCap(running)) throw new Error(ForkShell.capMessage(running).replace("shell commands", "monitors"))
          }

          if (!options.background) {
            const abort = Effect.callback<undefined>((resume) => {
              if (ctx.abort.aborted) return resume(Effect.succeed(undefined))
              const handler = () => resume(Effect.succeed(undefined))
              ctx.abort.addEventListener("abort", handler, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
            })
            const outcome = yield* Effect.raceAll([watch(options, ctx, bash), abort])
            return reply(outcome ? ForkMonitor.render(outcome) : "Monitor aborted.")
          }

          const job = yield* background.start({
            type: ForkMonitor.JOB_TYPE,
            title,
            // sessionId lets Session.remove cancel the job through cancelBackgroundJobs.
            metadata: { sessionId: ctx.sessionID },
            run: watch(options, ctx, bash).pipe(Effect.map(ForkMonitor.result)),
          })

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          // Cancelled jobs (session close) stay silent.
          yield* background.wait({ id: job.id }).pipe(
            Effect.flatMap((result) => {
              if (!ops || result.info?.status === "cancelled") return Effect.void
              const output = result.info?.status === "completed" ? (result.info.output ?? "") : `error\n${result.info?.error ?? ""}`
              return ops
                .prompt({
                  sessionID: ctx.sessionID,
                  agent: ctx.agent,
                  parts: [{ type: "text", synthetic: true, text: ForkMonitor.renderMessage({ id: job.id, output }) }],
                })
                .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
            }),
            Effect.forkIn(scope, { startImmediately: true }),
          )

          return reply(ForkMonitor.startedMessage(job.id))
        }),
    }
  }),
)
