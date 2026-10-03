import type { ForkRoute } from "@opencode-fork/core/route"
import { ForkCompactionLog } from "@opencode-fork/core/compaction-log"
import { ForkJev } from "@opencode-fork/core/jev"
import { ForkRouteLog } from "@opencode-fork/core/route-log"
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
      .option("tools", { type: "boolean", default: false, describe: "print tool definition sizes of the last turn" })
      .option("route", { type: "boolean", default: false, describe: "print the Router decision journal (signals, tier, model, reason, fallback)" })
      .option("jev", { type: "boolean", default: false, describe: "print Jev (TypeSafe) calls per use: success rate, latency, decisions, agreement with the old path" })
      .option("json", { type: "boolean", default: false, describe: "print raw rows as JSON" }),
  handler: (args) => {
    if (args.jev) return jev(args.json)
    if (args.route) return route(args.session, args.json)
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
    routeSection(args.session)
    compactionSection(args.session)
    console.log("")
    console.log("By agent")
    Object.entries(Object.groupBy(steps, (s) => s.agent)).forEach(([agent, rows = []]) =>
      console.log(
        `  ${agent.padEnd(12)} ${String(rows.length).padStart(4)} turns  ${usd(sum((s) => s.cost, rows)).padStart(9)}  ${tok(sum((s) => s.input + s.cache_read + s.cache_write, rows)).padStart(8)} in`,
      ),
    )
    const last = steps.findLast((s) => s.tool_chars)
    if (args.tools && last) {
      // Same chars -> tokens ratio the turn's allocation used for the tools category.
      const ratio = last.chars_tools === 0 ? 0 : last.est_tools / last.chars_tools
      console.log("")
      console.log(`Tool definitions (last turn, ${last.tool_count} tools)`)
      Object.entries(JSON.parse(last.tool_chars ?? "{}") as Record<string, number>)
        .toSorted((a, b) => b[1] - a[1])
        .forEach(([name, chars]) => console.log(`  ${name.padEnd(40)} ${tok(Math.round(chars * ratio)).padStart(8)}`))
    }
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

function jev(json: boolean) {
  const rows = ForkJev.recent(2000)
  if (json) return console.log(JSON.stringify(rows.toReversed(), null, 2))
  if (!rows.length) return console.log("No Jev calls yet. Set TYPESAFE_API_KEY.")
  const percentile = (values: number[], at: number) => values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * at)] ?? 0
  console.log(`Jev, last ${rows.length} calls`)
  Object.entries(Object.groupBy(rows, (row) => row.feature)).forEach(([feature, group = []]) => {
    const ms = group.map((row) => row.ms)
    const compared = group.filter((row) => row.ok && row.other !== null)
    console.log(
      `  ${feature.padEnd(14)} ${String(group.length).padStart(5)} calls  ok ${pct(group.filter((row) => row.ok).length, group.length).padStart(5)}  p50 ${percentile(ms, 0.5)}ms  p95 ${percentile(ms, 0.95)}ms${
        compared.length ? `  agree ${pct(compared.filter((row) => row.decision === row.other).length, compared.length)} of ${compared.length}` : ""
      }`,
    )
    const decisions = Object.entries(Object.groupBy(group.filter((row) => row.decision), (row) => row.decision ?? "")).map(
      ([name, items = []]) => `${name} ${items.length}`,
    )
    if (decisions.length) console.log(`    ${decisions.join("  ")}`)
    const error = group.find((row) => row.error)?.error
    if (error) console.log(`    last error: ${error}`)
  })
}

function route(session: string | undefined, json: boolean) {
  const rows = ForkRouteLog.recent(session ? 200 : 30, session).toReversed()
  if (json) return console.log(JSON.stringify(rows, null, 2))
  if (!rows.length) return console.log("No Router decisions yet. Pick router/auto in /models.")
  if (!session) {
    console.log("Router, by model")
    ForkRouteLog.summary().forEach((row) =>
      console.log(
        `  ${row.model.padEnd(44)} ${row.tier.padEnd(10)} ${String(row.turns).padStart(4)} turns  ${String(row.fallbacks).padStart(3)} fallbacks`,
      ),
    )
    console.log("")
  }
  console.log(session ? `Router decisions for ${session}` : "Router, latest decisions")
  rows.forEach((row) => {
    const signals = row.signals ? (JSON.parse(row.signals) as ForkRoute.Signals) : undefined
    const seen = signals
      ? `  ${signals.task_type} c${signals.complexity.toFixed(2)} r${signals.reasoning.toFixed(2)} t${signals.tool_intensity.toFixed(2)} conf ${signals.confidence.toFixed(2)} via ${signals.source ?? "small-model"}`
      : ""
    console.log(
      `${new Date(row.time).toLocaleTimeString()}  ${row.kind === "fallback" ? "FALLBACK" : row.kind === "escalation" ? "ESCALATE" : row.mode.padEnd(8)}  ${row.tier.padEnd(9)} ${row.provider_id}/${row.model_id}${row.variant ? ` [${row.variant}]` : ""}${seen}`,
    )
    console.log(`    ${row.reason}${row.error ? `  [after ${row.error}]` : ""}${session ? "" : `  (${row.session_id})`}`)
  })
}

function routeSection(session: string) {
  const rows = ForkRouteLog.recent(200, session)
  if (!rows.length) return
  console.log("")
  console.log("Router")
  const turns = rows.filter((row) => row.kind === "decision").length
  console.log(`  ${turns} routed turns, ${rows.length - turns} fallbacks (opencode usage --route ${session} for the detail)`)
  Object.entries(Object.groupBy(rows.filter((row) => row.kind === "decision"), (row) => `${row.tier} ${row.provider_id}/${row.model_id}`)).forEach(
    ([key, group = []]) => console.log(`  ${key.padEnd(52)} ${String(group.length).padStart(4)} turns`),
  )
}

function compactionSection(session: string) {
  const rows = ForkCompactionLog.list(session)
  if (!rows.length) return
  console.log("")
  console.log(`Smart compaction  ${rows.filter((row) => row.compact).length} compacted, ${rows.filter((row) => !row.compact).length} skipped`)
  rows.slice(-10).forEach((row) =>
    console.log(
      `  ${new Date(row.time).toLocaleTimeString()}  ${row.phase.padEnd(5)} ${row.compact ? "COMPACT" : "skip   "} ${row.code.padEnd(17)} ${row.reason}`,
    ),
  )
}

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
