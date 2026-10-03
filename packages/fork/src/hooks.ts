export * as ForkHooks from "./hooks"

export const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "PreCompact",
  "PermissionRequest",
] as const

export type Event = (typeof EVENTS)[number]

export interface Entry {
  matcher?: string
  command: string
  timeout?: number
}

export type Hooks = Partial<Record<Event, Entry[]>>

export type Decision = "block" | "allow" | "deny" | "ask"

export interface Payload {
  event: Event
  sessionID?: string
  cwd: string
  tool?: string
  args?: unknown
  output?: unknown
  prompt?: string
  permission?: unknown
}

export interface Outcome {
  decision?: Decision
  reason?: string
  additionalContext?: string
  args?: Record<string, unknown>
  error?: string
}

// Contract: SessionStart (session.created) and Stop (session.idle) are fire-and-forget event hooks;
// nothing waits on them, so a Stop hook's additionalContext is ignored.
export const DEFAULT_TIMEOUT = 60_000

// Hooks are on unless OPENCODE_FORK_HOOKS=0.
export function enabled() {
  return process.env.OPENCODE_FORK_HOOKS !== "0"
}

// Lenient normalisation of the `hooks` config value: malformed entries are dropped.
export function parse(input: unknown): Hooks {
  if (typeof input !== "object" || input === null) return {}
  const record = input as Record<string, unknown>
  return Object.fromEntries(
    EVENTS.flatMap((event) => {
      const raw = record[event]
      if (!Array.isArray(raw)) return []
      const entries = raw.flatMap((item): Entry[] => {
        if (typeof item !== "object" || item === null) return []
        const entry = item as Record<string, unknown>
        if (typeof entry.command !== "string" || !entry.command.trim()) return []
        return [
          {
            command: entry.command,
            ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}),
            ...(typeof entry.timeout === "number" && entry.timeout > 0 ? { timeout: entry.timeout } : {}),
          },
        ]
      })
      return entries.length ? [[event, entries] as const] : []
    }),
  )
}

// A missing matcher, "" or "*" matches everything. Otherwise the whole name must match
// the (case-insensitive) regular expression; an invalid expression matches nothing.
export function select(hooks: Hooks, event: Event, name?: string) {
  return (hooks[event] ?? []).filter((entry) => {
    if (!entry.matcher || entry.matcher === "*") return true
    if (name === undefined) return true
    return matches(entry.matcher, name)
  })
}

function matches(matcher: string, name: string) {
  const regex = compile(matcher)
  return regex ? regex.test(name) : false
}

function compile(matcher: string) {
  try {
    return new RegExp(`^(?:${matcher})$`, "i")
  } catch {
    return undefined
  }
}

export function payload(input: Payload) {
  return JSON.stringify(input)
}

const DECISIONS: readonly string[] = ["block", "allow", "deny", "ask"]

// Exit 0 continues (stdout may carry a JSON decision), exit 2 blocks with stderr as the reason,
// any other exit code or a timeout is a non-blocking error.
export function interpret(result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): Outcome {
  if (result.timedOut) return { error: "hook timed out" }
  if (result.code === 2) return { decision: "block", reason: result.stderr.trim() || "Blocked by hook" }
  if (result.code !== 0) return { error: result.stderr.trim() || `hook exited with code ${result.code}` }
  const text = result.stdout.trim()
  if (!text.startsWith("{")) return {}
  const json = parseObject(text)
  if (!json) return {}
  return {
    ...(typeof json.decision === "string" && DECISIONS.includes(json.decision)
      ? { decision: json.decision as Decision }
      : {}),
    ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
    ...(typeof json.additionalContext === "string" && json.additionalContext
      ? { additionalContext: json.additionalContext }
      : {}),
    ...(typeof json.args === "object" && json.args !== null && !Array.isArray(json.args)
      ? { args: json.args as Record<string, unknown> }
      : {}),
  }
}

function parseObject(text: string) {
  const value: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

const SEVERITY: Record<Decision, number> = { allow: 1, ask: 2, deny: 3, block: 3 }

// Strictest decision wins (allow < ask < deny/block); contexts are concatenated in order and the
// last `args` replacement wins.
export function combine(outcomes: Outcome[]): Outcome {
  const decisions = outcomes.flatMap((outcome) => (outcome.decision ? [outcome] : []))
  const strictest = decisions.reduce<Outcome | undefined>(
    (best, outcome) => (!best || SEVERITY[outcome.decision!] > SEVERITY[best.decision!] ? outcome : best),
    undefined,
  )
  const context = outcomes.flatMap((outcome) => (outcome.additionalContext ? [outcome.additionalContext] : []))
  const args = outcomes.findLast((outcome) => outcome.args)?.args
  return {
    ...(strictest ? { decision: strictest.decision, reason: strictest.reason } : {}),
    ...(context.length ? { additionalContext: context.join("\n") } : {}),
    ...(args ? { args } : {}),
  }
}

export function blocked(outcome: Outcome) {
  return outcome.decision === "block" || outcome.decision === "deny"
}

// In-band signal from the UserPromptSubmit hook: a text part carrying this metadata key holds the block reason.
export const PROMPT_BLOCK_KEY = "forkHookPromptBlock"

export function promptBlockReason(parts: readonly { type: string; text?: string; metadata?: Record<string, unknown> }[]) {
  return parts.find((part) => part.type === "text" && part.metadata?.[PROMPT_BLOCK_KEY] === true)?.text
}

export async function run(entry: Entry, event: Payload): Promise<Outcome> {
  const timeout = entry.timeout ?? DEFAULT_TIMEOUT
  const proc = Bun.spawn(["sh", "-c", entry.command], {
    cwd: event.cwd,
    stdin: new Blob([payload(event)]),
    stdout: "pipe",
    stderr: "pipe",
    // Own process group so a timeout can kill the hook's grandchildren too.
    detached: process.platform !== "win32",
    env: { ...process.env, OPENCODE_HOOK_EVENT: event.event },
  })
  const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => interpret({ code, stdout, stderr }),
  )
  const timer = Promise.withResolvers<Outcome>()
  const handle = setTimeout(() => {
    if (process.platform === "win32") proc.kill("SIGKILL")
    else killGroup(proc.pid)
    timer.resolve(interpret({ code: null, stdout: "", stderr: "", timedOut: true }))
  }, timeout)
  const outcome = await Promise.race([finished, timer.promise])
  clearTimeout(handle)
  return outcome
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // The group already exited.
  }
}

// Runs every selected hook in parallel and merges their outcomes. Non-blocking errors are reported
// through `onError` and otherwise ignored.
export async function runAll(
  entries: Entry[],
  event: Payload,
  onError?: (entry: Entry, error: string) => void,
): Promise<Outcome> {
  const outcomes = await Promise.all(entries.map((entry) => run(entry, event)))
  outcomes.forEach((outcome, index) => {
    if (outcome.error) onError?.(entries[index]!, outcome.error)
  })
  return combine(outcomes)
}
