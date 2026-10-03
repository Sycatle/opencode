// Replays the frozen tasks against an opencode binary and records cost, tokens,
// time and success. Totals come from opencode's own `session` table (including
// subagent sessions), so upstream and fork binaries are measured the same way.
//
//   bun run bench/run.ts --label fork --model anthropic/claude-haiku-4-5
//   bun run bench/run.ts --label upstream --bin opencode --model anthropic/claude-haiku-4-5
//   bun run bench/run.ts compare results/upstream-*.json results/fork-*.json
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
const results: Result[] = []
for (let run = 0; run < Number(args.values.runs); run++)
  for (const task of selected) {
    const result = await runTask(task)
    results.push(result)
    console.log(
      `${task.id.padEnd(10)} ${result.ok ? "ok  " : "FAIL"} ${result.seconds.toFixed(0).padStart(4)}s  $${result.cost.toFixed(4)}  in ${result.input + result.cache_read + result.cache_write}  out ${result.output}  ${result.sessionID ?? ""} ${result.error ?? ""}`,
    )
  }

const out = path.join(import.meta.dir, "results", `${args.values.label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
await fs.mkdir(path.dirname(out), { recursive: true })
await Bun.write(out, JSON.stringify({ label: args.values.label, model: args.values.model, bin, results }, null, 2))
console.log(`\n${out}`)

async function runTask(task: (typeof tasks)[number]): Promise<Result> {
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
    { stdout: "pipe", stderr: "pipe" },
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
  const proc = Bun.spawn([...bin, "db", query, "--format", "json"], { stdout: "pipe", stderr: "pipe" })
  const rows: Omit<Result, "task" | "ok" | "seconds">[] = JSON.parse(await new Response(proc.stdout).text())
  return rows[0]
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
  console.log(`${"".padEnd(10)} ${left.label.padStart(14)} ${right.label.padStart(14)} ${"delta".padStart(9)}`)
  for (const key of ["success", "cost", "input", "output", "seconds"] as const)
    console.log(
      `${key.padEnd(10)} ${l[key].toFixed(key === "cost" ? 4 : 2).padStart(14)} ${r[key].toFixed(key === "cost" ? 4 : 2).padStart(14)} ${delta(l[key], r[key]).padStart(9)}`,
    )
}
