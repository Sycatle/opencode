export * as ForkHooks from "./hooks"

export const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Notification",
] as const

export type Event = (typeof EVENTS)[number]

interface Base {
  matcher?: string
  timeout?: number
}

export interface CommandEntry extends Base {
  type: "command"
  command: string
}

export interface HttpEntry extends Base {
  type: "http"
  url: string
  headers?: Record<string, string>
}

export interface PromptEntry extends Base {
  type: "prompt"
  prompt: string
}

export type Entry = CommandEntry | HttpEntry | PromptEntry

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
  parentID?: string
  agent?: string
  error?: string
  message?: string
  notificationType?: string
  reason?: string
}

export interface Outcome {
  decision?: Decision
  reason?: string
  additionalContext?: string
  args?: Record<string, unknown>
  error?: string
}

// Sends a prompt to the (small) model of the current provider and resolves with its raw text answer.
export type Ask = (prompt: string, event: Payload) => Promise<string>

export interface Deps {
  ask?: Ask
}

// Contract: SessionStart (session.created), Stop and SubagentStop (session.idle), SessionEnd and Notification
// are fire-and-forget event hooks: they cannot block. Only SessionStart additionalContext is used (first message of a root session).
export const DEFAULT_TIMEOUT = 60_000

// Hooks are on unless OPENCODE_FORK_HOOKS=0.
export function enabled() {
  return process.env.OPENCODE_FORK_HOOKS !== "0"
}

export function describe(entry: Entry) {
  if (entry.type === "http") return entry.url
  if (entry.type === "prompt") return entry.prompt
  return entry.command
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
        const base = {
          ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}),
          ...(typeof entry.timeout === "number" && entry.timeout > 0 ? { timeout: entry.timeout } : {}),
        }
        const type = entry.type ?? "command"
        if (type === "command") {
          if (typeof entry.command !== "string" || !entry.command.trim()) return []
          return [{ type, command: entry.command, ...base }]
        }
        if (type === "http") {
          if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) return []
          const headers = parseHeaders(entry.headers)
          return [{ type, url: entry.url, ...(headers ? { headers } : {}), ...base }]
        }
        if (type === "prompt") {
          if (typeof entry.prompt !== "string" || !entry.prompt.trim()) return []
          return [{ type, prompt: entry.prompt, ...base }]
        }
        return []
      })
      return entries.length ? [[event, entries] as const] : []
    }),
  )
}

function parseHeaders(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const pairs = Object.entries(input).flatMap(([key, value]) => (typeof value === "string" ? [[key, value] as const] : []))
  return pairs.length ? Object.fromEntries(pairs) : undefined
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
  return interpretJson(result.stdout)
}

// The JSON contract shared by command stdout and http response bodies.
export function interpretJson(stdout: string): Outcome {
  const text = stdout.trim()
  if (!text.startsWith("{")) return {}
  const json = parseObject(text)
  if (!json) return {}
  // Claude Code plugins nest it under hookSpecificOutput.
  const specific = json.hookSpecificOutput
  const nested =
    typeof specific === "object" && specific !== null && "additionalContext" in specific
      ? specific.additionalContext
      : undefined
  const context = [json.additionalContext, nested].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  return {
    ...(typeof json.decision === "string" && DECISIONS.includes(json.decision)
      ? { decision: json.decision as Decision }
      : {}),
    ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
    ...(context ? { additionalContext: context } : {}),
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

export async function run(entry: Entry, event: Payload, deps?: Deps): Promise<Outcome> {
  if (entry.type === "http") return runHttp(entry, event)
  if (entry.type === "prompt") return runPrompt(entry, event, deps?.ask)
  return runCommand(entry, event)
}

async function runCommand(entry: CommandEntry, event: Payload): Promise<Outcome> {
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

// Expands $VAR and ${VAR} from the environment; unset variables become empty.
export function expand(value: string) {
  return value.replace(
    /\$\{(\w+)\}|\$(\w+)/g,
    (_, braced: string | undefined, bare: string | undefined) => process.env[braced ?? bare ?? ""] ?? "",
  )
}

// A 2xx response with a JSON body follows the stdout contract; any other status is a non-blocking error.
async function runHttp(entry: HttpEntry, event: Payload): Promise<Outcome> {
  const signal = AbortSignal.timeout(entry.timeout ?? DEFAULT_TIMEOUT)
  const response = await fetch(entry.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(Object.entries(entry.headers ?? {}).map(([key, value]) => [key, expand(value)])),
    },
    body: payload(event),
    signal,
  }).catch((error: unknown) => (signal.aborted ? "timeout" : error instanceof Error ? error.message : String(error)))
  if (response === "timeout") return { error: "hook timed out" }
  if (typeof response === "string") return { error: response }
  if (!response.ok) return { error: `hook returned HTTP ${response.status}` }
  return interpretJson(await response.text().catch(() => ""))
}

const PROMPT_INSTRUCTIONS =
  'Answer with a single JSON object and nothing else: { "ok": boolean, "reason"?: string }. Use ok=false to block, with the reason.'

async function runPrompt(entry: PromptEntry, event: Payload, ask: Ask | undefined): Promise<Outcome> {
  if (!ask) return { error: "prompt hooks need model access, which is unavailable here" }
  const text = entry.prompt.replaceAll("$ARGUMENTS", () => payload(event))
  const timer = Promise.withResolvers<"timeout">()
  const handle = setTimeout(() => timer.resolve("timeout"), entry.timeout ?? DEFAULT_TIMEOUT)
  const answer = await Promise.race([
    ask(`${text}\n\n${PROMPT_INSTRUCTIONS}`, event).catch((error: unknown) => ({
      failed: error instanceof Error ? error.message : String(error),
    })),
    timer.promise,
  ])
  clearTimeout(handle)
  if (answer === "timeout") return { error: "hook timed out" }
  if (typeof answer !== "string") return { error: `prompt hook failed: ${answer.failed}` }
  return interpretVerdict(answer)
}

// The model must answer { ok: boolean, reason?: string }; ok=false blocks with the reason.
export function interpretVerdict(answer: string): Outcome {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  const json = start >= 0 && end > start ? parseObject(answer.slice(start, end + 1)) : undefined
  if (!json || typeof json.ok !== "boolean") return { error: "prompt hook did not answer with { ok, reason }" }
  if (json.ok) return {}
  return {
    decision: "block",
    reason: typeof json.reason === "string" && json.reason ? json.reason : "Blocked by prompt hook",
  }
}

// Runs every selected hook in parallel and merges their outcomes. Non-blocking errors are reported
// through `onError` and otherwise ignored.
export async function runAll(
  entries: Entry[],
  event: Payload,
  onError?: (entry: Entry, error: string) => void,
  deps?: Deps,
): Promise<Outcome> {
  const outcomes = await Promise.all(entries.map((entry) => run(entry, event, deps)))
  outcomes.forEach((outcome, index) => {
    if (outcome.error) onError?.(entries[index]!, outcome.error)
  })
  return combine(outcomes)
}
