// Cache-aware compaction. Upstream summarizes with a separate request (compaction
// agent prompt, no tools, serialized transcript), so the whole context is billed
// at the full input price. Instead, the summary request replays the session's last
// provider request byte for byte (same tools, system, params) and only appends a
// final user instruction: the context is read from the prompt cache.
//
// Facts that structured data already holds (modified files, todo list, recent tool
// errors) are not left to the model: they are appended verbatim to the summary.

// Anthropic's default cache TTL is 5 minutes; past this the cache is likely cold
// and the upstream path (truncated transcript) is cheaper.
export const WARM_MS = 4.5 * 60 * 1000
const MIN_SUMMARY_CHARS = 200
const MAX_FILES = 60
const MAX_ERROR_CHARS = 300
const RECENT_ASSISTANT_MESSAGES = 3

type Remembered<T> = { messageID: string; input: T; time: number }

const last = new Map<string, Remembered<unknown>>()

export function remember<T>(sessionID: string, messageID: string, input: T) {
  last.set(sessionID, { messageID, input, time: Date.now() })
}

export function recall<T>(sessionID: string, now = Date.now()) {
  const entry = last.get(sessionID) as Remembered<T> | undefined
  if (!entry || now - entry.time > WARM_MS) return undefined
  return entry
}

export function forget(sessionID: string) {
  last.delete(sessionID)
}

export function enabled() {
  return process.env.OPENCODE_FORK_CACHED_COMPACTION !== "0"
}

export const PROMPT = `Stop working on the task. Do not call any tool.

The conversation above is about to be replaced by your summary: another coding agent will continue the work from it alone. If the conversation starts with an earlier summary, carry forward everything from it that is still relevant.

Do not list modified files, the todo list, or recent tool errors: they are appended automatically.

Output exactly the Markdown structure below and keep the section order unchanged.

## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

// Replaying is only cheaper when the cached context is large compared to the
// transcript upstream would send instead (tool outputs truncated, no system/tools).
// Costs are compared in full-price input-token equivalents.
export function worthIt(input: { context: number; delta: number; legacy: number; cacheRatio: number }) {
  return input.context * input.cacheRatio + input.delta < input.legacy
}

export function acceptable(result: { text: string; toolCalls: number }) {
  return result.toolCalls === 0 && result.text.trim().length >= MIN_SUMMARY_CHARS
}

type Part = {
  type: string
  files?: readonly string[]
  tool?: string
  metadata?: Record<string, unknown>
  state?: { status: string; input?: unknown; error?: string }
}

type Message = { info: { role: string }; parts: readonly Part[] }

export type Facts = {
  files: string[]
  todos: { content: string; status: string }[]
  errors: string[]
}

export function facts(messages: readonly Message[]): Facts {
  const parts = messages.flatMap((message) => message.parts)
  const previous = parts.flatMap((part) => {
    const value = part.metadata?.forkFacts
    return isFacts(value) ? [value] : []
  })
  const files = [
    ...new Set([
      ...previous.flatMap((item) => item.files),
      ...parts.flatMap((part) => (part.type === "patch" ? (part.files ?? []) : [])),
    ]),
  ].slice(-MAX_FILES)
  const todoPart = parts.findLast(
    (part) => part.type === "tool" && part.tool === "todowrite" && part.state?.status === "completed",
  )
  const todos = todoPart ? readTodos(todoPart.state?.input) : (previous.at(-1)?.todos ?? [])
  const errors = messages
    .filter((message) => message.info.role === "assistant")
    .slice(-RECENT_ASSISTANT_MESSAGES)
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool" && part.state?.status === "error"
        ? [`${part.tool}: ${(part.state.error ?? "").slice(0, MAX_ERROR_CHARS)}`]
        : [],
    )
  return { files, todos, errors }
}

export function formatFacts(value: Facts) {
  const sections = [
    value.files.length ? ["## Modified Files", ...value.files.map((file) => `- ${file}`)].join("\n") : undefined,
    value.todos.length
      ? ["## Todo List", ...value.todos.map((todo) => `- [${todo.status}] ${todo.content}`)].join("\n")
      : undefined,
    value.errors.length ? ["## Recent Tool Errors", ...value.errors.map((error) => `- ${error}`)].join("\n") : undefined,
  ].filter((section): section is string => section !== undefined)
  return sections.length ? sections.join("\n\n") : undefined
}

function readTodos(input: unknown) {
  if (!isRecord(input) || !Array.isArray(input.todos)) return []
  return input.todos.flatMap((todo) =>
    isRecord(todo) && typeof todo.content === "string" && typeof todo.status === "string"
      ? [{ content: todo.content, status: todo.status }]
      : [],
  )
}

function isFacts(value: unknown): value is Facts {
  return isRecord(value) && Array.isArray(value.files) && Array.isArray(value.todos) && Array.isArray(value.errors)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export * as ForkCompaction from "./compaction"
