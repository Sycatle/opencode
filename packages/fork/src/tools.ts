import { ForkFlags } from "./flags"
import { jsonSchema, tool, type Tool } from "ai"
import type { ForkJev } from "./jev"

// Deferred tools: MCP tool definitions are the largest chunk of every request
// (often more than all native tools together) yet most turns never use them.
// They are withheld until the model loads them through `deferred_tool_search`. The set of
// loaded tools is derived from session history, so it survives restarts and every
// turn of a session sees the same tool list until the model loads something new.

// Avoid OpenAI's reserved `tool_search` provider tool name. The AI SDK treats
// that exact name as a hosted Responses API tool and expects { arguments }.
export const SEARCH = "deferred_tool_search"
export const LEGACY_SEARCH = "tool_search"
const MAX_MATCHES = 5
const NATIVE_DEFERRABLE = [
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
  "question",
  "shell_output",
  "shell_kill",
  "monitor",
  "workflow",
  "list_agents",
  "send_message",
  "schedule_wakeup",
  "enter_worktree",
  "exit_worktree",
]

// Rarely used native tools, deferred like MCP ones. OPENCODE_FORK_DEFER_NATIVE:
// "0" disables, a comma-separated list overrides the default.
export function nativeDeferrable() {
  const value = process.env.OPENCODE_FORK_DEFER_NATIVE?.trim()
  if (value === "0") return []
  if (!value) return NATIVE_DEFERRABLE
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

type HistoryPart = {
  type: string
  tool?: string
  state?: { status: string; metadata?: Record<string, unknown> }
  // Text parts only: `forkPreloaded` lists tools loaded ahead of the model's own request (see `preloadRequest`).
  metadata?: Record<string, unknown>
}

// How tools are named and described to the model (the Claude tool profile renames them).
export interface View {
  name: (tool: string) => string
  description: (tool: string, description: string | undefined) => string | undefined
}

const NATIVE_VIEW: View = { name: (tool) => tool, description: (_tool, description) => description }

export function defer(
  tools: Record<string, Tool>,
  deferrable: string[],
  messages: { parts: readonly HistoryPart[] }[],
  view = NATIVE_VIEW,
) {
  if (!ForkFlags.on("DEFER_TOOLS")) return tools
  const candidates = deferrable.filter((name) => name in tools).toSorted()
  if (!candidates.length) return tools
  const loaded = loadedTools(messages)
  const pool = Object.fromEntries(candidates.map((name) => [name, tools[name]]))
  candidates.filter((name) => !loaded.has(name)).forEach((name) => delete tools[name])
  // Kept even once everything is loaded: earlier turns reference it, and removing
  // it would change the tool block and invalidate the prompt cache.
  tools[SEARCH] = searchTool(pool, view)
  return tools
}

// Anthropic's own tool search (Messages API through @ai-sdk/anthropic): deferred tools are sent with
// `defer_loading` and the API finds them, so loading one never changes the tool block and the prompt cache survives.
export const NATIVE_SEARCH = "tool_search_tool_bm25"

export function native(npm: string) {
  return ForkFlags.on("DEFER_TOOLS") && ForkFlags.on("NATIVE_TOOL_SEARCH") && npm === "@ai-sdk/anthropic"
}

export function deferNative(
  tools: Record<string, Tool>,
  deferrable: string[],
  messages: { parts: readonly HistoryPart[] }[],
  search: Tool,
) {
  const candidates = deferrable.filter((name) => name in tools)
  if (!candidates.length) return tools
  // A session that ran on the legacy tool_search keeps what it loaded: those calls have no tool_reference in
  // history to bring their definition back. Once the native search was used, discovered tools stay deferred.
  const used = messages.some((message) =>
    message.parts.some((part) => part.type === "tool" && part.tool === NATIVE_SEARCH),
  )
  const loaded = used ? new Set<string>() : loadedTools(messages)
  candidates
    .filter((name) => !loaded.has(name))
    .forEach((name) => {
      const original = tools[name]
      const options = original.providerOptions ?? {}
      tools[name] = {
        ...original,
        providerOptions: { ...options, anthropic: { ...options.anthropic, deferLoading: true } },
      }
    })
  tools[NATIVE_SEARCH] = search
  return tools
}

// opencode-claude-auth renames every tool of a request to `mcp_<Name>`, server tools included, and the API only
// accepts their fixed names. The plugin sends the request with the global fetch, the only place left to undo it.
export function restoreServerToolNames(body: string) {
  if (!body.includes('"tool_search_tool_')) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || !("tools" in parsed) || !Array.isArray(parsed.tools))
      return undefined
    const match = (type: unknown) =>
      typeof type === "string" ? /^(tool_search_tool_(?:bm25|regex))_\d+$/.exec(type)?.[1] : undefined
    const fixed = parsed.tools.map((item: unknown) => {
      if (typeof item !== "object" || item === null || !("type" in item)) return item
      const name = match(item.type)
      return name ? { ...item, name } : item
    })
    return JSON.stringify({ ...parsed, tools: fixed })
  } catch {
    return undefined
  }
}

// A search result in history can name a tool the request no longer defines (plan_exit is denied to the build
// agent it switches to), and the API rejects a tool_reference to an undefined tool. Only the request knows both.
export function dropDanglingToolReferences(body: string) {
  if (!body.includes('"tool_reference"')) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isObject(parsed) || !Array.isArray(parsed.tools) || !Array.isArray(parsed.messages)) return undefined
    const defined = new Set(parsed.tools.flatMap((item) => (isObject(item) && typeof item.name === "string" ? [item.name] : [])))
    let changed = false
    const messages = parsed.messages.map((message: unknown) => {
      if (!isObject(message) || !Array.isArray(message.content)) return message
      return {
        ...message,
        content: message.content.map((block: unknown) => {
          if (!isObject(block) || block.type !== "tool_search_tool_result") return block
          const result = block.content
          if (!isObject(result) || !Array.isArray(result.tool_references)) return block
          const kept = result.tool_references.filter(
            (ref: unknown) => !isObject(ref) || typeof ref.tool_name !== "string" || defined.has(ref.tool_name),
          )
          if (kept.length === result.tool_references.length) return block
          changed = true
          return { ...block, content: { ...result, tool_references: kept } }
        }),
      }
    })
    return changed ? JSON.stringify({ ...parsed, messages }) : undefined
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let guarded = false

export function guardServerToolNames() {
  if (guarded) return
  guarded = true
  const original = globalThis.fetch
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = typeof init?.body === "string" ? init.body : undefined
    const restored = body ? restoreServerToolNames(body) : undefined
    const fixed = restored ?? body
    const cleaned = fixed ? (dropDanglingToolReferences(fixed) ?? restored) : undefined
    return original(input, cleaned ? { ...init, body: cleaned } : init)
  }, original)
}

// The stored output of a native search, as the JSON the API expects back in history: a text output would be
// dropped and leave its server_tool_use without a result. Pruning never applies to it, it is a few names.
export function nativeSearchOutput(output: string) {
  try {
    const value: unknown = JSON.parse(output)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function loadedTools(messages: { parts: readonly HistoryPart[] }[]) {
  return new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.type === "text") return strings(part.metadata?.forkPreloaded)
        if (part.type !== "tool" || !part.tool) return []
        // A tool that already appears in history must stay defined for replay.
        if (part.tool !== SEARCH && part.tool !== LEGACY_SEARCH) return [part.tool]
        return strings(part.state?.status === "completed" ? part.state.metadata?.loaded : undefined)
      }),
    ),
  )
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : []
}

const PRELOAD_AT = 0.8

// Deferred tools worth a Jev question: the best keyword matches of the user's request, not loaded yet.
export function preloadCandidates(pool: Record<string, Tool>, prompt: string, loaded: ReadonlySet<string>) {
  // Short words match everything ("a" is in "slack"): only words of four letters or more count.
  const query = prompt
    .slice(0, 1_500)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length >= 4)
    .join(" ")
  return search(Object.fromEntries(Object.entries(pool).filter(([name]) => !loaded.has(name))), query, MAX_MATCHES)
}

export function preloadRequest(pool: Record<string, Tool>, names: readonly string[], prompt: string) {
  return {
    state: [
      "A coding agent received this request and has deferred tools it can load. Decide for each tool whether the agent will need it for this request.",
      `Request:\n${prompt.trim().slice(0, 1_500)}`,
      ...names.map((name, index) => `[t${index}] ${name}: ${(pool[name]?.description ?? "").slice(0, 200)}`),
    ].join("\n\n"),
    questions: Object.fromEntries(
      names.map((name, index) => [
        `t${index}`,
        { type: "noul" as const, instructions: `The agent will need tool [t${index}] (${name}) for this request` },
      ]),
    ) satisfies Record<string, ForkJev.Question>,
  }
}

export function preloadPicks(names: readonly string[], answers: Record<string, ForkJev.Answer>) {
  return names.filter((_, index) => (answers[`t${index}`]?.noul ?? 0) >= PRELOAD_AT)
}

// Preloading changes the tool block, which comes first in the prompt: it is only free when the cache holds
// nothing worth keeping, i.e. on the first turn after a start or a compaction, or after the cache expired.
export function preloadWindow(input: { turnsSinceStart: number; idleMs: number; ttlMs: number }) {
  return input.turnsSinceStart === 0 || input.idleMs > input.ttlMs
}

export function search(pool: Record<string, Tool>, query: string, max = MAX_MATCHES) {
  const names = Object.keys(pool)
  if (query.startsWith("select:"))
    return query
      .slice("select:".length)
      .split(",")
      .map((name) => name.trim())
      .filter((name) => names.includes(name))
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return names
    .map((name) => {
      const haystack = `${name} ${pool[name].description ?? ""}`.toLowerCase()
      const score = terms.reduce(
        (sum, term) => sum + (name.toLowerCase().includes(term) ? 3 : 0) + (haystack.includes(term) ? 1 : 0),
        0,
      )
      return { name, score }
    })
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, max)
    .map((item) => item.name)
}

function searchTool(pool: Record<string, Tool>, view: View) {
  return tool({
    description: [
      "Load deferred tools so they can be called. The tools listed below exist but their definitions are not loaded; they cannot be called until loaded.",
      `Query forms: "select:name1,name2" loads exact tools; otherwise keywords match tool names and descriptions (best ${MAX_MATCHES}).`,
      "Loaded tools become callable from your next step. Load every tool you expect to need in one call.",
      "",
      "Deferred tools:",
      ...Object.keys(pool).map(view.name),
    ].join("\n"),
    inputSchema: jsonSchema<{ query: string; max_results?: number }>({
      type: "object",
      properties: {
        query: { type: "string", description: 'Keywords, or "select:<name>[,<name>...]"' },
        max_results: { type: "number", description: `Maximum keyword matches to load (default ${MAX_MATCHES})` },
      },
      required: ["query"],
    }),
    async execute(args) {
      const loaded = search(pool, args.query, args.max_results && args.max_results > 0 ? args.max_results : MAX_MATCHES)
      return {
        title: args.query,
        metadata: { loaded },
        output: loaded.length
          ? `Loaded ${loaded.length} tool(s), callable from your next step:\n${loaded.map((name) => `- ${view.name(name)}: ${view.description(name, pool[name].description) ?? ""}`).join("\n")}`
          : `No deferred tool matches "${args.query}".`,
      }
    },
  })
}

export * as ForkTools from "./tools"
