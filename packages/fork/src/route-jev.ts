import { TASK_TYPES, truncate, type ContextSize, type Signals, type Summary } from "./route"

// Router signals from Jev (TypeSafe), ported from llm-router (src/router/classifier.rs, `JevClassifier`).
// One structured-classification call replaces the small-model prompt: a `choice` question for the task
// type, four 4-level `score` questions and a `noul` for ambiguity. No key, or any failure, and the
// caller falls back to the small model. What leaves the machine is documented in docs/fork/route.md.

const LEVELS = 4
const DEFAULT_URL = "https://api.typesafe.ai"
const DEFAULT_MODEL = "jev-latest"
const DEFAULT_TIMEOUT_MS = 1500

type Env = Record<string, string | undefined>

export function enabled(env: Env = process.env) {
  return !!env.TYPESAFE_API_KEY && env.OPENCODE_FORK_ROUTE_JEV !== "0"
}

export function timeout(env: Env = process.env) {
  const value = Number(env.OPENCODE_FORK_ROUTE_JEV_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

export function endpoint(env: Env = process.env) {
  return `${(env.OPENCODE_FORK_ROUTE_JEV_URL || DEFAULT_URL).replace(/\/+$/, "")}/v1/systemone`
}

function score(instructions: string, criteria: [string, string, string, string]) {
  return { type: "score", instructions, criteria }
}

export type Input = { prompt: string; summary: Summary }

function state(input: Input) {
  const summary = input.summary
  const lines = ["Coding-agent request to route to the cheapest sufficient LLM."]
  if (summary.first) lines.push(`Conversation opened with: ${truncate(summary.first, 500)}`)
  lines.push(
    `Messages so far: ${summary.messages}. Approx context tokens: ${summary.tokens}. Tools available: ${
      summary.tools?.length ? summary.tools.slice(0, 20).join(", ") : "none"
    }.`,
  )
  lines.push(`Latest user message:\n${truncate(input.prompt, 3000)}`)
  return lines.join("\n")
}

export function request(input: Input, env: Env = process.env) {
  return {
    state: state(input),
    model: env.OPENCODE_FORK_ROUTE_JEV_MODEL || DEFAULT_MODEL,
    questions: {
      task_type: {
        type: "choice",
        instructions: "What kind of software engineering task is the latest user message asking for?",
        criteria: {
          question: "Simple question or explanation, no code change",
          repo_search: "Find or read something in the repository",
          small_edit: "Typo, rename, tiny local edit, trivial generation, rewording",
          feature: "Implement a standard feature or production code",
          debugging: "Diagnose and fix a bug or failure",
          refactor: "Restructure existing code",
          architecture: "System design, cross-cutting analysis of a whole codebase",
          tests: "Write or fix tests",
          docs: "Write or update documentation",
          other: "None of the above",
        },
      },
      complexity: score("Overall difficulty of the task", ["Trivial", "Routine", "Hard", "Very hard / massive scope"]),
      reasoning: score("Amount of deep reasoning required", [
        "None",
        "Some",
        "Substantial multi-step",
        "Maximal, subtle, e.g. concurrency or distributed systems",
      ]),
      tool_intensity: score("Expected number of tool calls (file reads, edits, commands)", [
        "None",
        "A few",
        "Many",
        "Dozens across many files",
      ]),
      latency_sensitivity: score("How much the user needs a fast answer", [
        "Can wait",
        "Normal",
        "Wants it quick",
        "Interactive, instant",
      ]),
      ambiguity: { type: "noul", instructions: "The request is ambiguous, underspecified or open-ended" },
    },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

// Undefined when the answer is not usable (missing question, missing score): the caller falls back.
// Scores 0..3 become levels 0..1; the confidence is the mean of the answers' own (0.5 when none).
export function parse(body: unknown, size: ContextSize): Signals | undefined {
  const answers = record(record(body)?.answers)
  if (!answers) return undefined
  const get = (key: string) => record(answers[key])
  const level = (key: string) => {
    const value = number(get(key)?.score)
    return value === undefined ? undefined : clamp(value / (LEVELS - 1))
  }
  const complexity = level("complexity")
  const reasoning = level("reasoning")
  const tool_intensity = level("tool_intensity")
  const latency_sensitivity = level("latency_sensitivity")
  const task = get("task_type")
  const ambiguity = get("ambiguity")
  if (
    complexity === undefined ||
    reasoning === undefined ||
    tool_intensity === undefined ||
    latency_sensitivity === undefined ||
    !task ||
    !ambiguity
  )
    return undefined
  const confidences = Object.values(answers).flatMap((answer) => {
    const value = number(record(answer)?.confidence)
    return value === undefined ? [] : [value]
  })
  return {
    task_type: TASK_TYPES.find((item) => item === task.choice) ?? "other",
    complexity,
    reasoning,
    tool_intensity,
    latency_sensitivity,
    ambiguity: clamp(number(ambiguity.noul) ?? 0),
    context_size: size,
    confidence: confidences.length ? clamp(confidences.reduce((sum, value) => sum + value, 0) / confidences.length) : 0.5,
  }
}

export type Result = { signals: Signals; error?: undefined } | { signals?: undefined; error: string }

// POST to Jev with a bearer token. Never throws: the error text says why the caller must fall back.
export async function call(
  input: Input & { size: ContextSize },
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Result> {
  const response = await fetcher(endpoint(env), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
    body: JSON.stringify(request(input, env)),
    signal: AbortSignal.timeout(timeout(env)),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error) return { error: `Jev request failed: ${response.message}` }
  if (!response.ok) return { error: `Jev returned HTTP ${response.status}` }
  const body: unknown = await response.json().catch(() => undefined)
  const signals = parse(body, input.size)
  return signals ? { signals } : { error: "Jev response unusable" }
}

export * as ForkRouteJev from "./route-jev"
