import { jsonSchema, tool, type Tool } from "ai"

// Deferred tools: MCP tool definitions are the largest chunk of every request
// (often more than all native tools together) yet most turns never use them.
// They are withheld until the model loads them through `tool_search`. The set of
// loaded tools is derived from session history, so it survives restarts and every
// turn of a session sees the same tool list until the model loads something new.

export const SEARCH = "tool_search"
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
  if (process.env.OPENCODE_FORK_DEFER_TOOLS === "0") return tools
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

export function loadedTools(messages: { parts: readonly HistoryPart[] }[]) {
  return new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.type !== "tool" || !part.tool) return []
        // A tool that already appears in history must stay defined for replay.
        if (part.tool !== SEARCH) return [part.tool]
        const names = part.state?.status === "completed" ? part.state.metadata?.loaded : undefined
        return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []
      }),
    ),
  )
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
