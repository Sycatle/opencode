import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { cmd } from "./cmd"

export const UsageCommand = cmd({
  command: "usage [session]",
  describe: "show per-turn token breakdown (system, tools, history, tool output) and cache efficiency",
  builder: (yargs) =>
    yargs
      .positional("session", { type: "string", describe: "session ID (default: list recent sessions)" })
      .option("children", { type: "boolean", default: true, describe: "include subagent sessions" })
      .option("steps", { type: "boolean", default: false, describe: "print every provider turn" })
      .option("json", { type: "boolean", default: false, describe: "print raw rows as JSON" }),
  handler: (args) => {
    if (!args.session) {
      const rows = ForkTelemetry.recentSessions(15)
      if (args.json) return console.log(JSON.stringify(rows, null, 2))
      if (!rows.length) return console.log("No recorded turns yet.")
      rows.forEach((row) =>
        console.log(
          `${row.session_id}  ${new Date(row.last).toLocaleString()}  ${String(row.steps).padStart(4)} turns  ${usd(row.cost)}`,
        ),
      )
      return
    }
    const steps = ForkTelemetry.steps(args.session, { children: args.children })
    if (args.json) return console.log(JSON.stringify(steps, null, 2))
    if (!steps.length) return console.log(`No recorded turns for ${args.session}.`)
    const sum = (pick: (step: ForkTelemetry.Step) => number, rows = steps) =>
      rows.reduce((total, step) => total + pick(step), 0)
    const inputSide = sum((s) => s.input + s.cache_read + s.cache_write)
    const sessions = new Set(steps.map((s) => s.session_id)).size

    console.log(`Session ${args.session}  ${steps.length} turns across ${sessions} session(s)`)
    console.log(
      `Cost ${usd(sum((s) => s.cost))}   input-side ${tok(inputSide)}   output ${tok(sum((s) => s.output + s.reasoning))}   cache hit ${pct(sum((s) => s.cache_read), inputSide)}   cache write ${tok(sum((s) => s.cache_write))}`,
    )
    console.log("")
    console.log("Input-side tokens by category (estimated)")
    const categories = [
      ["system", sum((s) => s.est_system)],
      ["tools", sum((s) => s.est_tools)],
      ["history", sum((s) => s.est_history)],
      ["tool output", sum((s) => s.est_tool_output)],
    ] as const
    categories.forEach(([name, value]) =>
      console.log(`  ${name.padEnd(12)} ${tok(value).padStart(8)}  ${pct(value, inputSide).padStart(6)}`),
    )
    console.log("")
    console.log("By agent")
    Object.entries(Object.groupBy(steps, (s) => s.agent)).forEach(([agent, rows = []]) =>
      console.log(
        `  ${agent.padEnd(12)} ${String(rows.length).padStart(4)} turns  ${usd(sum((s) => s.cost, rows)).padStart(9)}  ${tok(sum((s) => s.input + s.cache_read + s.cache_write, rows)).padStart(8)} in`,
      ),
    )
    if (!args.steps) return
    console.log("")
    console.log("  #  agent        context    system     tools   history  tool out   output   cache      cost")
    steps.forEach((s, i) =>
      console.log(
        [
          String(i + 1).padStart(3),
          s.agent.padEnd(10),
          tok(s.input + s.cache_read + s.cache_write).padStart(9),
          tok(s.est_system).padStart(9),
          tok(s.est_tools).padStart(9),
          tok(s.est_history).padStart(9),
          tok(s.est_tool_output).padStart(9),
          tok(s.output + s.reasoning).padStart(8),
          pct(s.cache_read, s.input + s.cache_read + s.cache_write).padStart(7),
          usd(s.cost).padStart(9),
        ].join(" "),
      ),
    )
  },
})

function tok(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function pct(part: number, total: number) {
  return total === 0 ? "-" : `${((part / total) * 100).toFixed(1)}%`
}

function usd(value: number) {
  return `$${value.toFixed(4)}`
}
