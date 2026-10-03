import { Database } from "bun:sqlite"
import path from "path"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Global } from "@opencode-ai/core/global"

// Per-request token breakdown. Providers only report aggregate input tokens, so
// each category is measured in characters on the final request (after plugin
// transforms) and the billed input tokens are allocated proportionally.

export type Chars = {
  system: number
  tools: number
  history: number
  tool_output: number
}

export type Step = {
  id: number
  session_id: string
  parent_session_id: string | null
  message_id: string
  agent: string
  provider_id: string
  model_id: string
  time: number
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
  cost: number
  tool_count: number
  message_count: number
  media_count: number
  chars_system: number
  chars_tools: number
  chars_history: number
  chars_tool_output: number
  est_system: number
  est_tools: number
  est_history: number
  est_tool_output: number
  // JSON object: tool name -> characters of its definition
  tool_chars: string | null
}

type Measure = {
  agent: string
  parentSessionID?: string
  chars: Chars
  tool_count: number
  tool_chars: Record<string, number>
  message_count: number
  media_count: number
}

type Request = {
  agent: string
  parentSessionID?: string
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
}

type Usage = {
  sessionID: string
  messageID: string
  providerID: string
  modelID: string
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost: number
}

// Keyed by session: the main loop runs one provider turn at a time per session.
// Small-model side calls (titles) must not be measured or they clobber the entry.
const pending = new Map<string, Promise<Measure>>()

export function measure(sessionID: string, request: Request) {
  pending.set(sessionID, measureRequest(request))
}

export async function record(usage: Usage) {
  const measured = pending.get(usage.sessionID)
  pending.delete(usage.sessionID)
  // Telemetry must never break a session turn.
  try {
    insert(usage, measured ? await measured : undefined)
  } catch {}
}

export function steps(sessionID: string, options?: { children?: boolean }) {
  if (!options?.children)
    return db().query<Step, [string]>(`SELECT * FROM fork_usage WHERE session_id = ? ORDER BY id`).all(sessionID)
  return db()
    .query<Step, [string]>(
      `WITH RECURSIVE tree(id) AS (
        SELECT ?
        UNION SELECT DISTINCT fork_usage.session_id FROM fork_usage JOIN tree ON fork_usage.parent_session_id = tree.id
      )
      SELECT * FROM fork_usage WHERE session_id IN (SELECT id FROM tree) ORDER BY id`,
    )
    .all(sessionID)
}

export function recentSessions(limit: number) {
  return db()
    .query<{ session_id: string; last: number; steps: number; cost: number }, [number]>(
      `SELECT session_id, max(time) AS last, count(*) AS steps, sum(cost) AS cost
      FROM fork_usage WHERE parent_session_id IS NULL
      GROUP BY session_id ORDER BY last DESC LIMIT ?`,
    )
    .all(limit)
}

export function allocate(total: number, chars: Chars) {
  const sum = chars.system + chars.tools + chars.history + chars.tool_output
  const share = (value: number) => (sum === 0 ? 0 : Math.round((total * value) / sum))
  return {
    system: share(chars.system),
    tools: share(chars.tools),
    history: share(chars.history),
    tool_output: share(chars.tool_output),
  }
}

export async function measureRequest(request: Request): Promise<Measure> {
  const system = request.messages.filter((message) => message.role === "system")
  const rest = request.messages.filter((message) => message.role !== "system")
  const tools = await Promise.all(
    // "invalid" only exists to repair malformed calls; it is never sent (see activeTools).
    Object.entries(request.tools)
      .filter(([name]) => name !== "invalid")
      .map(async ([name, tool]) => [name, await toolChars(name, tool)] as const),
  )
  const parts = rest.map((message) => contentChars(message.content))
  return {
    agent: request.agent,
    parentSessionID: request.parentSessionID,
    chars: {
      system: system.length
        ? system.reduce((sum, message) => sum + message.content.length, 0)
        : request.system.reduce((sum, text) => sum + text.length, 0),
      tools: tools.reduce((sum, [, value]) => sum + value, 0),
      history: rest.reduce((sum, message, i) => (message.role === "tool" ? sum : sum + parts[i].chars), 0),
      tool_output: rest.reduce((sum, message, i) => (message.role === "tool" ? sum + parts[i].chars : sum), 0),
    },
    tool_count: tools.length,
    tool_chars: Object.fromEntries(tools),
    message_count: rest.length,
    media_count: parts.reduce((sum, value) => sum + value.media, 0),
  }
}

async function toolChars(name: string, tool: Tool) {
  const schema = "inputSchema" in tool && tool.inputSchema ? await asSchema(tool.inputSchema).jsonSchema : {}
  return name.length + (tool.description?.length ?? 0) + JSON.stringify(schema).length
}

// Binary parts (images, files) are counted, not measured: their token cost is
// provider-specific and base64 length would dwarf every other category.
function contentChars(content: ModelMessage["content"]) {
  if (typeof content === "string") return { chars: content.length, media: 0 }
  return content.reduce(
    (acc, part) => {
      if (part.type === "image" || part.type === "file") return { chars: acc.chars, media: acc.media + 1 }
      if (part.type === "text" || part.type === "reasoning") return { chars: acc.chars + part.text.length, media: acc.media }
      if (part.type === "tool-result" && part.output.type === "content")
        return part.output.value.reduce(
          (inner, item) =>
            item.type === "text"
              ? { chars: inner.chars + item.text.length, media: inner.media }
              : { chars: inner.chars, media: inner.media + 1 },
          acc,
        )
      return { chars: acc.chars + JSON.stringify(part).length, media: acc.media }
    },
    { chars: 0, media: 0 },
  )
}

function insert(usage: Usage, measured: Measure | undefined) {
  const chars = measured?.chars ?? { system: 0, tools: 0, history: 0, tool_output: 0 }
  const est = allocate(usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write, chars)
  db()
    .query(
      `INSERT INTO fork_usage (
        session_id, parent_session_id, message_id, agent, provider_id, model_id, time,
        input, output, reasoning, cache_read, cache_write, cost,
        tool_count, message_count, media_count,
        chars_system, chars_tools, chars_history, chars_tool_output,
        est_system, est_tools, est_history, est_tool_output, tool_chars
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      usage.sessionID,
      measured?.parentSessionID ?? null,
      usage.messageID,
      measured?.agent ?? "unknown",
      usage.providerID,
      usage.modelID,
      Date.now(),
      usage.tokens.input,
      usage.tokens.output,
      usage.tokens.reasoning,
      usage.tokens.cache.read,
      usage.tokens.cache.write,
      usage.cost,
      measured?.tool_count ?? 0,
      measured?.message_count ?? 0,
      measured?.media_count ?? 0,
      chars.system,
      chars.tools,
      chars.history,
      chars.tool_output,
      est.system,
      est.tools,
      est.history,
      est.tool_output,
      measured ? JSON.stringify(measured.tool_chars) : null,
    )
}

let handle: Database | undefined

function db() {
  if (handle) return handle
  handle = new Database(process.env.OPENCODE_FORK_DB ?? path.join(Global.Path.data, "fork.db"), { create: true })
  handle.run("PRAGMA journal_mode = WAL")
  handle.run(`CREATE TABLE IF NOT EXISTS fork_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    message_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    reasoning INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost REAL NOT NULL,
    tool_count INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    media_count INTEGER NOT NULL,
    chars_system INTEGER NOT NULL,
    chars_tools INTEGER NOT NULL,
    chars_history INTEGER NOT NULL,
    chars_tool_output INTEGER NOT NULL,
    est_system INTEGER NOT NULL,
    est_tools INTEGER NOT NULL,
    est_history INTEGER NOT NULL,
    est_tool_output INTEGER NOT NULL,
    tool_chars TEXT
  )`)
  const columns = handle.query<{ name: string }, []>("PRAGMA table_info(fork_usage)").all()
  if (!columns.some((column) => column.name === "tool_chars")) handle.run("ALTER TABLE fork_usage ADD tool_chars TEXT")
  handle.run("CREATE INDEX IF NOT EXISTS fork_usage_session ON fork_usage (session_id)")
  handle.run("CREATE INDEX IF NOT EXISTS fork_usage_parent ON fork_usage (parent_session_id)")
  return handle
}

export * as ForkTelemetry from "./telemetry"
