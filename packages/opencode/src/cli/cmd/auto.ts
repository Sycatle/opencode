import path from "path"
import { ForkAutonomy } from "@opencode-fork/core/autonomy"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { cmd } from "./cmd"

export const AutoCommand = cmd({
  command: "auto <message..>",
  describe: "run the agent until a completion check passes, within a budget",
  builder: (yargs) =>
    yargs
      .positional("message", { type: "string", array: true, demandOption: true, describe: "task for the agent" })
      .option("until", { type: "string", demandOption: true, describe: "shell command that exits 0 when the task is done" })
      .option("budget", { type: "number", describe: "maximum cost in USD for the session and its subagents" })
      .option("max-iterations", { type: "number", default: 5, describe: "maximum agent runs" })
      .option("model", { type: "string", alias: "m", describe: "model to use in the format of provider/model" })
      .option("agent", { type: "string", describe: "agent to use" })
      .option("dir", { type: "string", describe: "directory to run in" })
      .option("auto", {
        type: "boolean",
        default: false,
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
      }),
  handler: async (args) => {
    const dir = path.resolve(args.dir ?? process.cwd())
    const self = ForkAutonomy.selfCommand(process.execPath, process.argv)
    const env = {
      ...process.env,
      ...(args.budget !== undefined ? { OPENCODE_FORK_BUDGET_USD: String(args.budget) } : {}),
    }
    let sessionID: string | undefined
    let prompt = args.message.join(" ")

    for (let iteration = 1; ; iteration++) {
      console.log(`\n== run ${iteration}/${args.maxIterations}`)
      const proc = Bun.spawn(
        [
          ...self,
          "run",
          "--format",
          "json",
          "--dir",
          dir,
          ...(sessionID ? ["--session", sessionID] : []),
          ...(args.model ? ["--model", args.model] : []),
          ...(args.agent ? ["--agent", args.agent] : []),
          ...(args.auto ? ["--auto"] : []),
          prompt,
        ],
        { stdout: "pipe", stderr: "inherit", env },
      )
      for await (const line of lines(proc.stdout)) {
        const event = parse(line)
        if (!event) continue
        sessionID ??= event.sessionID
        if (event.type === "text" && event.part?.text) console.log(event.part.text)
        if (event.type === "tool_use" && event.part?.tool) console.log(`  · ${event.part.tool} ${event.part.state?.title ?? ""}`)
        if (event.type === "error") console.log(`  ! ${JSON.stringify(event.error).slice(0, 300)}`)
      }
      await proc.exited

      const check = await runCheck(args.until, dir)
      const spent = sessionID ? ForkTelemetry.treeCost(sessionID) : 0
      console.log(`== check exit ${check.code} · spent $${spent.toFixed(4)}${sessionID ? ` · ${sessionID}` : ""}`)
      const decision = ForkAutonomy.decide({
        check,
        sessionID,
        command: args.until,
        iteration,
        maxIterations: args.maxIterations,
        spent,
        budget: args.budget,
      })
      if (decision.action === "continue") {
        prompt = decision.prompt
        continue
      }
      console.log(decision.action === "done" ? "== done: check passed" : `== stopped: ${decision.reason}`)
      if (decision.action === "stop") process.exitCode = 1
      return
    }
  },
})

async function runCheck(command: string, cwd: string): Promise<ForkAutonomy.Check> {
  const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, output: `${stdout}${stderr}` }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ""
  const reader = stream.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    yield* parts
  }
  if (buffer) yield buffer
}

type RunEvent = {
  type: string
  sessionID?: string
  error?: unknown
  part?: { text?: string; tool?: string; state?: { title?: string } }
}

function parse(line: string): RunEvent | undefined {
  if (!line.startsWith("{")) return undefined
  // Run output is line-delimited JSON; a malformed line is skipped, not fatal.
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
