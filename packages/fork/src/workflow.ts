import { ForkFlags } from "./flags"
import { createHash } from "crypto"
import { mkdirSync } from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ForkBudget } from "./budget"
import { ForkTelemetry } from "./telemetry"

export const JOB_TYPE = "workflow"

// The workflow tool is on unless OPENCODE_FORK_WORKFLOW_TOOL=0.
export function toolEnabled() {
  return ForkFlags.on("WORKFLOW_TOOL")
}

export type Schema = {
  type?: string
  required?: readonly string[]
  properties?: Record<string, Schema>
  items?: Schema
}

export type AgentOptions = { label?: string; agent?: string; model?: string; schema?: Schema }

export type Execution = { text: string; sessionID: string }

// Fired as soon as the child's session is known, so a child that dies mid-turn is still attributed to the run.
export type Started = (sessionID: string) => void

type Stage = (value: unknown, index: number) => unknown

type Answer = { ok: true; value: unknown } | { ok: false; problem: string }

export class BudgetExceeded extends Error {
  constructor(
    readonly spent: number,
    readonly budget: number,
  ) {
    super(`budget reached: $${spent.toFixed(4)} spent of $${budget}`)
  }
}

// Identical calls get distinct keys through an occurrence counter, so a resumed run maps them back in call order.
export function keyer() {
  const seen = new Map<string, number>()
  return (prompt: string, options: AgentOptions) => {
    const hash = createHash("sha256")
      .update(prompt + JSON.stringify(options))
      .digest("hex")
    const occurrence = seen.get(hash) ?? 0
    seen.set(hash, occurrence + 1)
    return `${hash}:${occurrence}`
  }
}

export function limiter(limit: number) {
  const state = { active: 0 }
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>) => {
    if (state.active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    else state.active++
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else state.active--
    }
  }
}

// Each item walks the stages on its own; a failing item yields null and skips its remaining stages.
export function pipeline(items: readonly unknown[], stages: readonly Stage[], onError: (error: unknown, index: number) => void) {
  return Promise.all(
    items.map(async (item, index) => {
      try {
        return await stages.reduce<Promise<unknown>>((acc, stage) => acc.then((value) => stage(value, index)), Promise.resolve(item))
      } catch (error) {
        onError(error, index)
        return null
      }
    }),
  )
}

export function validate(schema: Schema, value: unknown, at = "$"): string[] {
  if (schema.type && !matches(schema.type, value)) return [`${at}: expected ${schema.type}`]
  if (Array.isArray(value)) return schema.items ? value.flatMap((item, i) => validate(schema.items!, item, `${at}[${i}]`)) : []
  if (typeof value !== "object" || value === null) return []
  const record = value as Record<string, unknown>
  return [
    ...(schema.required ?? []).filter((key) => !(key in record)).map((key) => `${at}.${key}: missing`),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => (key in record ? validate(child, record[key], `${at}.${key}`) : [])),
  ]
}

function matches(type: string, value: unknown) {
  if (type === "array") return Array.isArray(value)
  if (type === "null") return value === null
  if (type === "integer") return Number.isInteger(value)
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value)
  return typeof value === type
}

export function schemaPrompt(prompt: string, schema: Schema) {
  return `${prompt}\n\nAnswer with a single JSON value in a fenced \`\`\`json block, matching this JSON Schema:\n${JSON.stringify(schema, null, 2)}`
}

// The last fenced block wins; an unfenced reply is tried as raw JSON.
export function parseAnswer(text: string, schema: Schema): Answer {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1] ?? text
  const parsed = safeParse(fenced.trim())
  if (!parsed.ok) return parsed
  const errors = validate(schema, parsed.value)
  return errors.length ? { ok: false, problem: errors.join("; ") } : parsed
}

function safeParse(text: string): Answer {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, problem: `not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}

export function parseScriptArgs(text: string | undefined) {
  if (text === undefined) return { ok: true as const, value: undefined }
  const parsed = safeParse(text)
  return parsed.ok ? parsed : { ok: false as const, message: `Invalid --args JSON: ${parsed.problem}` }
}

// Lets the fork budget inside a child agent stop it (with a wrap-up turn) before it overshoots the run budget.
export function budgetEnv(budget: number | undefined, spent: number): Record<string, string> {
  return budget === undefined ? {} : { OPENCODE_FORK_BUDGET_USD: String(Math.max(0, budget - spent)) }
}

type RunEvent = { type?: string; sessionID?: string; error?: unknown; part?: { text?: string } }

// Reads `opencode run --format json` lines; the answer is the text written after the last tool call.
export function replyFrom(lines: readonly string[]) {
  const events = lines.flatMap((line) => {
    if (!line.startsWith("{")) return []
    const parsed = safeParse(line)
    return parsed.ok ? [parsed.value as RunEvent] : []
  })
  const lastTool = events.findLastIndex((event) => event.type === "tool_use")
  return {
    sessionID: events.find((event) => event.sessionID)?.sessionID,
    text: events
      .slice(lastTool + 1)
      .flatMap((event) => (event.type === "text" && event.part?.text ? [event.part.text] : []))
      .join("\n"),
    error: JSON.stringify(events.find((event) => event.type === "error")?.error),
  }
}

export type Step = { key: string; label: string; session_id: string; result_json: string; cost: number }

export function cachedStep(runID: string, key: string) {
  return (
    table()
      .query<Step, [string, string]>(
        "SELECT key, label, session_id, result_json, cost FROM fork_workflow_steps WHERE run_id = ? AND key = ?",
      )
      .get(runID, key) ?? undefined
  )
}

export function saveStep(runID: string, step: Step) {
  table()
    .query(
      "INSERT OR REPLACE INTO fork_workflow_steps (run_id, key, label, session_id, result_json, cost, time) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(runID, step.key, step.label, step.session_id, step.result_json, step.cost, Date.now())
}

export function startRun(id: string, script: string, name: string) {
  table()
    .query(
      "INSERT INTO fork_workflow_runs (id, script, name, status, cost, started, pid) VALUES (?, ?, ?, 'running', 0, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'running', finished = NULL, pid = excluded.pid",
    )
    .run(id, script, name, Date.now(), process.pid)
}

export type Run = {
  id: string
  name: string
  status: string
  cost: number
  started: number
  finished: number | null
  pid: number | null
}

// A run still marked `running` whose process is gone was killed without a chance to say so.
export function reapRuns() {
  table()
    .query<{ id: string; pid: number | null }, []>("SELECT id, pid FROM fork_workflow_runs WHERE status = 'running'")
    .all()
    .filter((run) => run.pid === null || !alive(run.pid))
    .forEach((run) => finishRun(run.id, "interrupted"))
}

export function listRuns() {
  reapRuns()
  return table()
    .query<Run, []>("SELECT id, name, status, cost, started, finished, pid FROM fork_workflow_runs ORDER BY started DESC")
    .all()
}

export function isRunning(id: string) {
  reapRuns()
  return table().query("SELECT 1 FROM fork_workflow_runs WHERE id = ? AND status = 'running'").get(id) !== null
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function hasRun(id: string) {
  return table().query("SELECT 1 FROM fork_workflow_runs WHERE id = ?").get(id) !== null
}

// The run cost is read from telemetry by session, not from saved results: an agent that failed or was killed has no
// result, but the step-finish rows it already produced are in fork.db.
export function finishRun(id: string, status: "done" | "failed" | "budget" | "interrupted") {
  const total = table()
    .query<{ session_id: string }, [string]>("SELECT DISTINCT session_id FROM fork_workflow_steps WHERE run_id = ?")
    .all(id)
    .reduce((sum, step) => sum + ForkTelemetry.treeCost(step.session_id), 0)
  table()
    .query("UPDATE fork_workflow_runs SET status = ?, cost = ?, finished = ? WHERE id = ?")
    .run(status, total, Date.now(), id)
}

// `execute` runs one prompt in a session (continuing `sessionID` when given); the rest is bookkeeping.
// The concurrency limit applies to agent launches, not to thunks, so nested parallel() cannot deadlock.
export function createRuntime(input: {
  runID: string
  concurrency: number
  budget?: number
  execute: (prompt: string, options: AgentOptions, sessionID: string | undefined, started: Started) => Promise<Execution>
  cost?: (sessionID: string) => number
  progress: (line: string) => void
}) {
  const key = keyer()
  const limit = limiter(input.concurrency)
  const cost = input.cost ?? ForkTelemetry.treeCost
  const launched = new Set<string>()
  const state = { phase: "", halted: false }
  const spent = () => [...launched].reduce((sum, id) => sum + cost(id), 0)
  const report = (error: unknown) => input.progress(`! ${error instanceof Error ? error.message : String(error)}`)

  async function agent(prompt: string, options: AgentOptions = {}) {
    const stepKey = key(prompt, options)
    const label = options.label ?? prompt.replaceAll(/\s+/g, " ").slice(0, 40)
    // A placeholder step (never a cache hit) ties the session's spend to the run even if the agent is killed.
    const started: Started = (sessionID) => {
      launched.add(sessionID)
      saveStep(input.runID, {
        key: `started:${stepKey}:${sessionID}`,
        label,
        session_id: sessionID,
        result_json: "null",
        cost: 0,
      })
    }
    const tag = `[${state.phase || "-"}] ${label}`
    const cached = cachedStep(input.runID, stepKey)
    if (cached) {
      input.progress(`${tag}: cached`)
      return JSON.parse(cached.result_json) as unknown
    }
    return limit(async () => {
      if (input.budget !== undefined && spent() >= input.budget) {
        state.halted = true
        throw new BudgetExceeded(spent(), input.budget)
      }
      input.progress(`${tag}: started`)
      const first = await input.execute(
        options.schema ? schemaPrompt(prompt, options.schema) : prompt,
        options,
        undefined,
        started,
      )
      started(first.sessionID)
      const result = options.schema ? await structured(first, options.schema, started) : first.text
      const stepCost = cost(first.sessionID)
      saveStep(input.runID, {
        key: stepKey,
        label,
        session_id: first.sessionID,
        result_json: JSON.stringify(result),
        cost: stepCost,
      })
      input.progress(`${tag}: done ($${stepCost.toFixed(4)})`)
      return result
    })
  }

  async function structured(first: Execution, schema: Schema, started: Started) {
    const answer = parseAnswer(first.text, schema)
    if (answer.ok) return answer.value
    const retry = await input.execute(
      `Your previous answer was invalid: ${answer.problem}. Reply again with only the corrected JSON in a fenced \`\`\`json block.`,
      {},
      first.sessionID,
      started,
    )
    const second = parseAnswer(retry.text, schema)
    if (second.ok) return second.value
    throw new Error(`invalid structured answer after retry: ${second.problem}`)
  }

  return {
    agent,
    spent,
    get halted() {
      return state.halted
    },
    phase: (title: string) => {
      state.phase = title
      input.progress(`\n== ${title}`)
    },
    log: (message: string) => input.progress(message),
    parallel: (fns: readonly (() => Promise<unknown>)[]) =>
      Promise.all(
        fns.map(async (fn) => {
          try {
            return await fn()
          } catch (error) {
            report(error)
            return null
          }
        }),
      ),
    pipeline: (items: readonly unknown[], ...stages: Stage[]) => pipeline(items, stages, report),
  }
}

export type Meta = { name: string; description?: string }

type MetaResult = { ok: true; meta: Meta } | { ok: false; message: string }

const META_START = /export\s+const\s+meta\s*=\s*/

// `meta` must be a pure literal: it is read without running the script (permission pattern, validation).
export function parseMeta(source: string, options: { first?: boolean } = {}): MetaResult {
  const start = META_START.exec(source)
  if (!start) return { ok: false, message: "a workflow script must contain `export const meta = { name, description }`" }
  if (options.first && source.slice(0, start.index).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").trim())
    return { ok: false, message: "an inline script must begin with `export const meta = { ... }`" }
  const begin = start.index + start[0].length
  const end = literalEnd(source, begin)
  if (end === undefined) return { ok: false, message: "`meta` must be an object literal" }
  return metaOf(parseLiteral(source.slice(begin, end).replaceAll(/`([^`$\\]*)`/g, (_, text: string) => JSON.stringify(text))))
}

// JSON5 accepts unquoted keys, single quotes and trailing commas, and nothing executable.
function parseLiteral(text: string): unknown {
  try {
    return Bun.JSON5.parse(text)
  } catch {
    return undefined
  }
}

function metaOf(value: unknown): MetaResult {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  if (typeof record?.name !== "string" || !record.name.trim())
    return { ok: false, message: "`meta` must be a pure literal (no variables or calls) with a string `name`" }
  return {
    ok: true,
    meta: { name: record.name, description: typeof record.description === "string" ? record.description : undefined },
  }
}

// End (exclusive) of the object literal starting at `begin`, skipping braces inside strings.
function literalEnd(source: string, begin: number) {
  if (source[begin] !== "{") return undefined
  const state = { depth: 0, quote: "", escaped: false }
  for (let i = begin; i < source.length; i++) {
    const char = source[i]
    if (state.quote) {
      state.escaped = !state.escaped && char === "\\"
      if (!state.escaped && char === state.quote) state.quote = ""
      continue
    }
    if (char === '"' || char === "'" || char === "`") state.quote = char
    if (char === "{") state.depth++
    if (char === "}" && --state.depth === 0) return i + 1
  }
  return undefined
}

export function scriptsDir() {
  const dir = path.join(Global.Path.data, "workflows")
  mkdirSync(dir, { recursive: true })
  return dir
}

// The same source always lands in the same file, so a script can be reused through its path.
export async function writeScript(source: string) {
  const parsed = parseMeta(source, { first: true })
  if (!parsed.ok) throw new Error(parsed.message)
  const slug = parsed.meta.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "").slice(0, 40) || "workflow"
  const file = path.join(scriptsDir(), `${slug}-${createHash("sha256").update(source).digest("hex").slice(0, 8)}.js`)
  await Bun.write(file, source)
  return { path: file, meta: parsed.meta }
}

export async function readMeta(file: string) {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return { ok: false as const, message: `no such script: ${file}` }
  return parseMeta(await handle.text())
}

export function newRunID() {
  return `wf_${crypto.randomUUID().slice(0, 8)}`
}

// What the session still has to spend, so the run cannot outspend its parent.
export function remainingBudget(sessionID: string) {
  const limit = ForkBudget.limit()
  if (limit === undefined) return undefined
  return Math.max(0, limit - ForkTelemetry.treeCost(ForkTelemetry.rootOf(sessionID)))
}

export function getRun(id: string) {
  reapRuns()
  return (
    table()
      .query<Run & { script: string }, [string]>(
        "SELECT id, script, name, status, cost, started, finished, pid FROM fork_workflow_runs WHERE id = ?",
      )
      .get(id) ?? undefined
  )
}

export function runSteps(id: string) {
  return table()
    .query<Step, [string]>(
      "SELECT key, label, session_id, result_json, cost FROM fork_workflow_steps WHERE run_id = ? ORDER BY time",
    )
    .all(id)
}

// Completed steps carry a result; `started:` placeholders without a completed twin are agents still running.
export function describeRun(id: string) {
  const run = getRun(id)
  if (!run) return `No workflow run ${id}.`
  const steps = runSteps(id)
  const done = steps.filter((step) => !step.key.startsWith("started:"))
  const doneSessions = new Set(done.map((step) => step.session_id))
  const running = steps.filter((step) => step.key.startsWith("started:") && !doneSessions.has(step.session_id))
  return [
    `run ${run.id} · ${run.name} · ${run.status} · $${run.cost.toFixed(4)}`,
    `script: ${run.script}`,
    ...done.map((step) => `done     ${step.label}  $${step.cost.toFixed(4)}`),
    ...(run.status === "running" ? running.map((step) => `running  ${step.label}`) : []),
    ...(done.length + running.length ? [] : ["(no agent started yet)"]),
  ].join("\n")
}

const RESULT_LIMIT = 4000

export function renderMessage(input: {
  runID: string
  name: string
  state: "completed" | "error"
  result: string
  cost: number
  script: string
}) {
  const text = input.result.length > RESULT_LIMIT ? `${input.result.slice(0, RESULT_LIMIT)}\n... (truncated)` : input.result
  return [
    `<workflow id="${input.runID}" name="${input.name}" state="${input.state}" cost="$${input.cost.toFixed(4)}">`,
    input.state === "completed" ? "Background workflow finished. Returned value:" : "Background workflow did not finish:",
    text,
    `Script: ${input.script}. Retry or continue with scriptPath and resumeFromRunId "${input.runID}" (finished agent calls are not re-run).`,
    "</workflow>",
  ].join("\n")
}

export function startedMessage(input: { runID: string; jobID: string; script: string; log: string; resumed: boolean }) {
  return [
    `Workflow run ${input.runID} ${input.resumed ? "resumed" : "started"} in the background (job ${input.jobID}).`,
    `Script: ${input.script} (reuse it with scriptPath).`,
    `Progress log: ${input.log}. Step states: TaskOutput / shell_output (id: "${input.jobID}"); stop with TaskStop / shell_kill (a stopped run can be resumed with resumeFromRunId "${input.runID}").`,
    "You will be notified automatically with the returned value and the cost when it ends. Do not poll or sleep waiting for it.",
  ].join("\n")
}

let ready = false

function table() {
  const db = ForkTelemetry.db()
  if (ready) return db
  db.run(`CREATE TABLE IF NOT EXISTS fork_workflow_runs (
    id TEXT PRIMARY KEY,
    script TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    cost REAL NOT NULL,
    started INTEGER NOT NULL,
    finished INTEGER,
    pid INTEGER
  )`)
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(fork_workflow_runs)").all()
  if (!columns.some((column) => column.name === "pid")) db.run("ALTER TABLE fork_workflow_runs ADD pid INTEGER")
  db.run(`CREATE TABLE IF NOT EXISTS fork_workflow_steps (
    run_id TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    session_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    cost REAL NOT NULL,
    time INTEGER NOT NULL,
    PRIMARY KEY (run_id, key)
  )`)
  ready = true
  return db
}

export * as ForkWorkflow from "./workflow"
