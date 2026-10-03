export const JOB_TYPE = "monitor"

export const POLL_MS = 250
export const MIN_INTERVAL_MS = 500
export const DEFAULT_INTERVAL_MS = 2000
export const DEFAULT_TIMEOUT_MS = 600_000
export const MAX_TIMEOUT_MS = 3_600_000
export const CONTEXT_LINES = 3
export const TAIL_LINES = 20

export type Until = "match" | "exit" | "success"

export type Input = {
  id?: string
  command?: string
  pattern?: string
  until?: Until
  interval_ms?: number
  timeout_ms?: number
  background?: boolean
}

export type Options = {
  id?: string
  command?: string
  pattern?: RegExp
  until: Until
  intervalMs: number
  timeoutMs: number
  background: boolean
}

export function normalize(input: Input): Options | string {
  if (!input.id && !input.command) return "monitor needs a job id, a command, or both."
  if (input.pattern && !input.id) return "pattern is matched against the output of a background job: pass its id too."
  const pattern = compile(input.pattern)
  if (typeof pattern === "string") return pattern
  const until = input.until ?? (pattern ? "match" : input.id ? "exit" : "success")
  if (until === "match" && !pattern) return 'until "match" needs a pattern.'
  if (until === "exit" && !input.id) return 'until "exit" needs a job id.'
  return {
    id: input.id,
    command: input.command,
    pattern,
    until,
    intervalMs: Math.max(MIN_INTERVAL_MS, input.interval_ms ?? DEFAULT_INTERVAL_MS),
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1, input.timeout_ms ?? DEFAULT_TIMEOUT_MS)),
    background: input.background === true,
  }
}

function compile(pattern: string | undefined) {
  if (!pattern) return
  try {
    return new RegExp(pattern)
  } catch (error) {
    return `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`
  }
}

export type Feed = { carry: string; recent: string[] }

export const emptyFeed: Feed = { carry: "", recent: [] }

export type Hit = { line: string; before: string[]; after: string[] }

// Only complete lines are tested; an unterminated tail waits for the next chunk.
export function feed(state: Feed, chunk: string, pattern: RegExp): { state: Feed; hit?: Hit } {
  const parts = (state.carry + chunk).split("\n")
  const carry = parts.pop() ?? ""
  const lines = parts.map((line) => line.replace(/\r$/, ""))
  const index = lines.findIndex((line) => pattern.test(line))
  if (index === -1) return { state: { carry, recent: [...state.recent, ...lines].slice(-CONTEXT_LINES) } }
  return {
    state: { carry, recent: [] },
    hit: {
      line: lines[index]!,
      before: [...state.recent, ...lines.slice(0, index)].slice(-CONTEXT_LINES),
      after: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
    },
  }
}

export type Outcome =
  | { kind: "match"; hit: Hit }
  | { kind: "exit"; exit: number | null; tail: string; error?: string }
  | { kind: "success"; attempts: number; tail: string }
  | { kind: "timeout"; timeoutMs: number; attempts: number; lastExit: number | null | undefined }

// Whether the watcher is done, given the job state and the latest command attempt.
export function decide(input: {
  until: Until
  hasCommand: boolean
  jobEnded: boolean
  commandExit?: number | null
}): "success" | "exit" | undefined {
  if (input.until === "success" && input.hasCommand) return input.commandExit === 0 ? "success" : undefined
  return input.jobEnded ? "exit" : undefined
}

export function tailLines(text: string, lines = TAIL_LINES) {
  const all = text.replace(/\n$/, "").split("\n")
  return all.slice(Math.max(0, all.length - lines)).join("\n")
}

export function render(outcome: Outcome) {
  if (outcome.kind === "match")
    return ["Pattern matched:", ...outcome.hit.before, `> ${outcome.hit.line}`, ...outcome.hit.after].join("\n")
  if (outcome.kind === "success")
    return [
      `Command succeeded after ${outcome.attempts} attempt${outcome.attempts === 1 ? "" : "s"}.`,
      tailLines(outcome.tail),
    ]
      .filter(Boolean)
      .join("\n")
  if (outcome.kind === "exit")
    return [
      outcome.error
        ? `Job failed: ${outcome.error}`
        : `Job exited${outcome.exit === null ? "" : ` with code ${outcome.exit}`}.`,
      tailLines(outcome.tail),
    ]
      .filter(Boolean)
      .join("\n")
  const last = outcome.lastExit === undefined ? "" : ` Last command exit: ${outcome.lastExit ?? "none"}.`
  return `Timed out after ${outcome.timeoutMs} ms without the condition being met.${
    outcome.attempts ? ` ${outcome.attempts} attempts.` : ""
  }${last}`
}

// A monitor job output is `<kind>` followed by the rendered outcome, so the kind
// survives in the generic BackgroundJob record.
export function result(outcome: Outcome) {
  return `${outcome.kind}\n${render(outcome)}`
}

export function renderMessage(input: { id: string; output: string }) {
  const [kind = "", ...rest] = input.output.split("\n")
  return [`<monitor id="${input.id}" state="${kind}">`, rest.join("\n"), "</monitor>"].join("\n")
}

export function startedMessage(id: string) {
  return `Monitor started in the background as job ${id}. You will be notified automatically when the condition is met or it times out. Do not poll or sleep waiting for it.`
}

export const DESCRIPTION =
  'Wait for a condition without polling or sleeping. Watch a background bash job (id) for a regex in its new output (pattern), for its exit, or re-run a shell command (command) every interval_ms until it succeeds (exit 0). Blocks until the condition or timeout_ms; with background=true it returns immediately and you are notified when the condition fires or times out. until defaults to "match" with a pattern, "exit" with an id, "success" with a command.'

export * as ForkMonitor from "./monitor"
