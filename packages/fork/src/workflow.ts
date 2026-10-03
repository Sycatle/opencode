import { createHash } from "crypto"
import { ForkTelemetry } from "./telemetry"

export type Schema = {
  type?: string
  required?: readonly string[]
  properties?: Record<string, Schema>
  items?: Schema
}

export type AgentOptions = { label?: string; agent?: string; model?: string; schema?: Schema }

export type Execution = { text: string; sessionID: string }

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
      "INSERT INTO fork_workflow_runs (id, script, name, status, cost, started) VALUES (?, ?, ?, 'running', 0, ?) ON CONFLICT(id) DO UPDATE SET status = 'running', finished = NULL",
    )
    .run(id, script, name, Date.now())
}

export function hasRun(id: string) {
  return table().query("SELECT 1 FROM fork_workflow_runs WHERE id = ?").get(id) !== null
}

export function finishRun(id: string, status: "done" | "failed" | "budget") {
  const total = table()
    .query<{ cost: number | null }, [string]>("SELECT sum(cost) AS cost FROM fork_workflow_steps WHERE run_id = ?")
    .get(id)
  table()
    .query("UPDATE fork_workflow_runs SET status = ?, cost = ?, finished = ? WHERE id = ?")
    .run(status, total?.cost ?? 0, Date.now(), id)
}

// `execute` runs one prompt in a session (continuing `sessionID` when given); the rest is bookkeeping.
// The concurrency limit applies to agent launches, not to thunks, so nested parallel() cannot deadlock.
export function createRuntime(input: {
  runID: string
  concurrency: number
  budget?: number
  execute: (prompt: string, options: AgentOptions, sessionID?: string) => Promise<Execution>
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
      const first = await input.execute(options.schema ? schemaPrompt(prompt, options.schema) : prompt, options)
      launched.add(first.sessionID)
      const result = options.schema ? await structured(first, options.schema) : first.text
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

  async function structured(first: Execution, schema: Schema) {
    const answer = parseAnswer(first.text, schema)
    if (answer.ok) return answer.value
    const retry = await input.execute(
      `Your previous answer was invalid: ${answer.problem}. Reply again with only the corrected JSON in a fenced \`\`\`json block.`,
      {},
      first.sessionID,
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
    finished INTEGER
  )`)
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
