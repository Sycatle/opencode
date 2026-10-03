import path from "path"
import { pathToFileURL } from "url"
import { ForkAutonomy } from "@opencode-fork/core/autonomy"
import { ForkWorkflow } from "@opencode-fork/core/workflow"
import { cmd } from "./cmd"

const STARTUP_TIMEOUT_MS = 60_000

const RunCommand = cmd({
  command: "run <script>",
  describe: "run a workflow script of agent calls, with resumable steps and a budget",
  builder: (yargs) =>
    yargs
      .positional("script", { type: "string", demandOption: true, describe: "path to a .js/.ts workflow module" })
      .option("resume", { type: "string", describe: "run id to resume; completed agent calls are not re-run" })
      .option("args", { type: "string", describe: "JSON passed to the script as `args`" })
      .option("budget", { type: "number", describe: "stop launching agents once this many USD are spent" })
      .option("concurrency", { type: "number", default: 4, describe: "maximum agents running at once" })
      .option("dir", { type: "string", describe: "directory to run in" }),
  handler: async (args) => {
    const file = path.resolve(args.script)
    const dir = path.resolve(args.dir ?? process.cwd())
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.meta?.name !== "string" || typeof mod.default !== "function")
      return fail("a workflow must `export const meta = { name, description }` and export a default async function")
    if (args.resume && !ForkWorkflow.hasRun(args.resume)) return fail(`unknown run id ${args.resume}`)

    const runID = args.resume ?? `wf_${crypto.randomUUID().slice(0, 8)}`
    ForkWorkflow.startRun(runID, file, mod.meta.name)
    console.error(`run ${runID} · ${mod.meta.name}${args.resume ? " (resumed)" : ""}`)

    const self = ForkAutonomy.selfCommand(process.execPath, process.argv)
    const runtime = ForkWorkflow.createRuntime({
      runID,
      concurrency: args.concurrency,
      budget: args.budget,
      progress: (line) => console.error(line),
      execute: async (prompt, options, sessionID) => {
        const command = [
          ...self,
          "run",
          "--format",
          "json",
          "--dir",
          dir,
          ...(sessionID ? ["--session", sessionID] : []),
          ...(options.model ? ["--model", options.model] : []),
          ...(options.agent ? ["--agent", options.agent] : []),
          prompt,
        ]
        // A slow dev startup can leave `run` silent; one silent attempt is killed and retried once.
        const reply = (await attempt(command)) ?? (await attempt(command))
        if (!reply) throw new Error(`agent produced no event in ${STARTUP_TIMEOUT_MS / 1000}s, twice`)
        const id = reply.sessionID ?? sessionID
        if (!id) throw new Error("agent produced no session")
        if (reply.error) throw new Error(`agent failed: ${reply.error.slice(0, 300)}`)
        return { text: reply.text, sessionID: id }
      },
    })

    const outcome = await Promise.resolve(
      mod.default({
        agent: runtime.agent,
        parallel: runtime.parallel,
        pipeline: runtime.pipeline,
        phase: runtime.phase,
        log: runtime.log,
        args: args.args ? JSON.parse(args.args) : undefined,
      }),
    ).then(
      (value) => ({ value, error: undefined, failed: false }),
      (error: unknown) => ({ value: undefined, error, failed: true }),
    )

    if (outcome.failed || runtime.halted) {
      ForkWorkflow.finishRun(runID, runtime.halted ? "budget" : "failed")
      const reason = runtime.halted
        ? `stopped: budget $${args.budget} reached ($${runtime.spent().toFixed(4)} spent)`
        : `failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
      console.error(`== ${reason} · resume with --resume ${runID}`)
      process.exitCode = 1
      return
    }
    ForkWorkflow.finishRun(runID, "done")
    console.error(`== done · ${runID}`)
    console.log(JSON.stringify(outcome.value ?? null, null, 2))
  },
})

export const WorkflowCommand = cmd({
  command: "workflow",
  describe: "run scripted multi-agent workflows",
  builder: (yargs) => yargs.command(RunCommand).demandCommand(),
  handler: () => {},
})

function fail(message: string) {
  console.error(message)
  process.exitCode = 1
}

async function attempt(command: string[]) {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", env: process.env })
  const timer = setTimeout(() => proc.kill(), STARTUP_TIMEOUT_MS)
  const decoder = new TextDecoder()
  const state = { output: "", silent: true }
  const reader = proc.stdout.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (state.silent) clearTimeout(timer)
    state.silent = false
    state.output += decoder.decode(chunk.value, { stream: true })
  }
  clearTimeout(timer)
  await proc.exited
  return state.silent ? undefined : ForkWorkflow.replyFrom(state.output.split("\n"))
}
