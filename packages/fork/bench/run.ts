// Replays the frozen tasks against an opencode binary and records cost, tokens,
// time and success. Totals come from opencode's own `session` table (including
// subagent sessions), so upstream and fork binaries are measured the same way.
//
//   bun run bench/run.ts --label fork --model anthropic/claude-haiku-4-5
//   bun run bench/run.ts --label upstream --bin opencode --model anthropic/claude-haiku-4-5
//   bun run bench/run.ts compare results/upstream-*.json results/fork-*.json
//   bun run bench/run.ts --label noskills --env OPENCODE_FORK_SLIM_SKILLS=0 --model anthropic/claude-haiku-4-5
//   bun run bench/run.ts ablate --flags SLIM_SKILLS,SLIM_TOOLS --runs 2 --model anthropic/claude-haiku-4-5
// `ablate` runs the baseline, then each fork switch turned off, and prints success and cost against the baseline.
import { parseArgs } from "util"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tasks } from "./tasks"

type Result = {
  task: string
  ok: boolean
  error?: string
  sessionID?: string
  seconds: number
  cost: number
  input: number
  output: number
  cache_read: number
  cache_write: number
}

const args = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: "string", default: "fork" },
    bin: { type: "string" },
    model: { type: "string" },
    task: { type: "string", multiple: true },
    runs: { type: "string", default: "1" },
    env: { type: "string", multiple: true },
    flags: { type: "string" },
  },
})

if (args.positionals[0] === "compare") {
  await compare(args.positionals[1], args.positionals[2])
  process.exit(0)
}

const bin = args.values.bin
  ? args.values.bin.split(" ")
  : ["bun", "run", path.join(import.meta.dir, "../../opencode/src/index.ts")]
const selected = tasks.filter((task) => !args.values.task || args.values.task.includes(task.id))
// The user's Claude Code plugins (skills, SessionStart hooks) would make results depend on the machine:
// off unless --env OPENCODE_FORK_CC_PLUGINS=1.
const env = {
  OPENCODE_FORK_CC_PLUGINS: "0",
  ...Object.fromEntries((args.values.env ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])),
}

if (args.positionals[0] === "ablate") {
  const flags = (args.values.flags ?? "").split(",").map((flag) => flag.trim().toUpperCase()).filter(Boolean)
  if (!flags.length) throw new Error("ablate needs --flags NAME[,NAME...] (OPENCODE_FORK_ prefix optional)")
  const baseline = await runAll(args.values.label, env)
  const variants = []
  for (const flag of flags) {
    const name = `OPENCODE_FORK_${flag.replace(/^OPENCODE_FORK_/, "")}`
    variants.push(await runAll(`${args.values.label}-no-${flag.toLowerCase()}`, { ...env, [name]: "0" }))
  }
  for (const variant of variants) {
    console.log("")
    await compare(baseline, variant)
  }
  process.exit(0)
}

await runAll(args.values.label, env)

async function runAll(label: string, extra: Record<string, string>) {
  const results: Result[] = []
  for (let run = 0; run < Number(args.values.runs); run++)
    for (const task of selected) {
      const result = await runTask(task, extra)
      results.push(result)
      console.log(
        `${label.padEnd(16)} ${task.id.padEnd(10)} ${result.ok ? "ok  " : "FAIL"} ${result.seconds.toFixed(0).padStart(4)}s  $${result.cost.toFixed(4)}  in ${result.input + result.cache_read + result.cache_write}  out ${result.output}  ${result.sessionID ?? ""} ${result.error ?? ""}`,
      )
    }
  const out = path.join(import.meta.dir, "results", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await Bun.write(out, JSON.stringify({ label, model: args.values.model, bin, env: extra, results }, null, 2))
  console.log(out)
  return out
}

async function runTask(task: (typeof tasks)[number], extra: Record<string, string>): Promise<Result> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bench-${task.id}-`))
  await fs.cp(path.join(import.meta.dir, "fixture"), dir, { recursive: true })
  await sh("git init -q && git add -A && git -c user.email=bench@local -c user.name=bench commit -qm fixture", dir)

  const start = performance.now()
  const proc = Bun.spawn(
    [
      ...bin,
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      dir,
      ...(args.values.model ? ["--model", args.values.model] : []),
      task.prompt,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extra } },
  )
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  const seconds = (performance.now() - start) / 1000
  const events = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line): { type: string; sessionID?: string; error?: unknown } => JSON.parse(line))
  const sessionID = events.find((event) => event.sessionID)?.sessionID
  const error = events.find((event) => event.type === "error")?.error
  const ok = !error && (await sh(task.check, dir)) === 0
  const usage = sessionID ? await totals(sessionID) : undefined
  return {
    task: task.id,
    ok,
    error: error ? JSON.stringify(error).slice(0, 200) : sessionID ? undefined : "no session",
    sessionID,
    seconds,
    cost: usage?.cost ?? 0,
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cache_read: usage?.cache_read ?? 0,
    cache_write: usage?.cache_write ?? 0,
  }
}

async function totals(sessionID: string) {
  const query = `WITH RECURSIVE tree(id) AS (SELECT '${sessionID}' UNION SELECT session.id FROM session JOIN tree ON session.parent_id = tree.id)
    SELECT sum(cost) AS cost, sum(tokens_input) AS input, sum(tokens_output + tokens_reasoning) AS output,
      sum(tokens_cache_read) AS cache_read, sum(tokens_cache_write) AS cache_write
    FROM session WHERE id IN (SELECT id FROM tree)`
  // The run process may still hold the database while it shuts down: retry briefly.
  for (let attempt = 0; attempt < 5; attempt++) {
    const proc = Bun.spawn([...bin, "db", query, "--format", "json"], { stdout: "pipe", stderr: "pipe" })
    const text = await new Response(proc.stdout).text()
    if (text.trim().startsWith("[")) {
      const rows: Omit<Result, "task" | "ok" | "seconds">[] = JSON.parse(text)
      return rows[0]
    }
    await Bun.sleep(2000)
  }
  return undefined
}

async function sh(command: string, cwd: string) {
  const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "ignore", stderr: "ignore" })
  return proc.exited
}

async function compare(a: string, b: string) {
  const [left, right] = await Promise.all([Bun.file(a).json(), Bun.file(b).json()])
  const summarize = (results: Result[]) => ({
    success: results.filter((r) => r.ok).length / results.length,
    cost: results.reduce((sum, r) => sum + r.cost, 0),
    input: results.reduce((sum, r) => sum + r.input + r.cache_read + r.cache_write, 0),
    output: results.reduce((sum, r) => sum + r.output, 0),
    seconds: results.reduce((sum, r) => sum + r.seconds, 0),
  })
  const l = summarize(left.results)
  const r = summarize(right.results)
  const delta = (x: number, y: number) => (x === 0 ? "-" : `${(((y - x) / x) * 100).toFixed(1)}%`)
  // Per task: successes over runs, so a regression on one task is not averaged away.
  const ids = [...new Set([...left.results, ...right.results].map((r: Result) => r.task))]
  const rate = (results: Result[], id: string) => {
    const runs = results.filter((r) => r.task === id)
    return `${runs.filter((r) => r.ok).length}/${runs.length}`
  }
  console.log(`${"".padEnd(10)} ${left.label.padStart(14)} ${right.label.padStart(14)} ${"delta".padStart(9)}`)
  for (const key of ["success", "cost", "input", "output", "seconds"] as const)
    console.log(
      `${key.padEnd(10)} ${l[key].toFixed(key === "cost" ? 4 : 2).padStart(14)} ${r[key].toFixed(key === "cost" ? 4 : 2).padStart(14)} ${delta(l[key], r[key]).padStart(9)}`,
    )
  ids.forEach((id) => console.log(`  ${id.padEnd(8)} ${rate(left.results, id).padStart(14)} ${rate(right.results, id).padStart(14)}`))
}
