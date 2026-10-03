import { ForkJev } from "./jev"
import { TASK_TYPES, truncate, type ContextSize, type Signals, type Summary } from "./route"

// Router signals from Jev (TypeSafe), ported from llm-router (src/router/classifier.rs, `JevClassifier`).
// One structured-classification call replaces the small-model prompt: a `choice` question for the task
// type, four 4-level `score` questions and a `noul` for ambiguity. No key, or any failure, and the
// caller falls back to the small model. What leaves the machine is documented in docs/fork/route.md.

type Env = Record<string, string | undefined>

export function enabled(env: Env = process.env) {
  return ForkJev.mode("ROUTE", env) !== "off"
}

function score(instructions: string, criteria: [string, string, string, string]) {
  return { type: "score" as const, instructions, criteria }
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

export function request(input: Input) {
  return {
    state: state(input),
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
    } satisfies Record<string, ForkJev.Question>,
  }
}

// Undefined when the answer is not usable (missing question, missing score): the caller falls back.
// Scores 0..3 become levels 0..1; the confidence is the mean of the answers' own (0.5 when none).
export function parse(body: unknown, size: ContextSize) {
  const answers = ForkJev.answers(body)
  return answers && signals(answers, size)
}

function signals(answers: Record<string, ForkJev.Answer>, size: ContextSize): Signals | undefined {
  const complexity = ForkJev.level(answers.complexity)
  const reasoning = ForkJev.level(answers.reasoning)
  const tool_intensity = ForkJev.level(answers.tool_intensity)
  const latency_sensitivity = ForkJev.level(answers.latency_sensitivity)
  const task = answers.task_type
  const ambiguity = answers.ambiguity
  if (
    complexity === undefined ||
    reasoning === undefined ||
    tool_intensity === undefined ||
    latency_sensitivity === undefined ||
    !task ||
    !ambiguity
  )
    return undefined
  return {
    task_type: TASK_TYPES.find((item) => item === task.choice) ?? "other",
    complexity,
    reasoning,
    tool_intensity,
    latency_sensitivity,
    ambiguity: ForkJev.clamp(ambiguity.noul ?? 0),
    context_size: size,
    confidence: ForkJev.confidence(answers) ?? 0.5,
  }
}

export type Result =
  | { signals: Signals; ms: number; error?: undefined }
  | { signals?: undefined; error: string; ms: number }

// Never throws: the error text says why the caller must fall back.
export async function call(
  input: Input & { size: ContextSize; signal?: AbortSignal },
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Result> {
  const response = await ForkJev.ask({ ...request(input), signal: input.signal }, env, fetcher)
  if (response.error !== undefined) return { error: response.error, ms: response.ms }
  const parsed = signals(response.answers, input.size)
  return parsed ? { signals: parsed, ms: response.ms } : { error: "Jev response unusable", ms: response.ms }
}

export * as ForkRouteJev from "./route-jev"
