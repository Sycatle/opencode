// Prompt cache TTL for the stable prefix (tools + system prompt) on Anthropic.
// The default 5-minute cache expires during human pauses, and the whole prefix is
// then written again at 1.25x. A 1-hour write costs 2x once but survives pauses
// and is shared by later sessions of the same project. Interactive sessions use it;
// headless runs, which chain turns without pauses, keep 5 minutes.

export const INTERACTIVE_TTL = "1h"

export function systemTtl() {
  return process.env.OPENCODE_FORK_CACHE_TTL === "1h" ? ("1h" as const) : undefined
}

// `opencode-claude-auth` (Claude subscription) rewrites the request inside its own
// fetch, which opencode wraps: it moves every system block except the billing header
// and the Claude Code identity into the first user message and drops their
// `cache_control`, so the system TTL above never reaches the API. The plugin's final
// body is not observable (it calls the global fetch itself), so the breakpoint goes on
// the end of the first user message instead: that block, and the plugin's tools and
// content blocks, pass through untouched, and the prefix up to it (tools, system, the
// relocated system text, first message) is exactly the stable part.
const PLUGIN_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const MAX_BREAKPOINTS = 4

export function authCacheEnabled() {
  return systemTtl() !== undefined && process.env.OPENCODE_FORK_AUTH_CACHE !== "0"
}

export function isMessagesRequest(input: unknown) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : isRecord(input) ? input.url : undefined
  return typeof url === "string" && new URL(url, "http://local").pathname.endsWith("/v1/messages")
}

// Returns the rewritten body, or undefined when the request is not one the plugin
// will relocate (no identity-led system prompt) or nothing needs to change.
// Applied before the plugin, so system blocks still carry their (soon dropped) markers.
export function pinFirstUserMessage(body: unknown) {
  if (typeof body !== "string") return undefined
  const parsed = parse(body)
  if (!isRecord(parsed) || !Array.isArray(parsed.system) || !Array.isArray(parsed.messages)) return undefined
  const first = parsed.system[0]
  if (!isRecord(first) || typeof first.text !== "string" || !first.text.startsWith(PLUGIN_IDENTITY)) return undefined
  const user = parsed.messages.find((message) => isRecord(message) && message.role === "user")
  if (!isRecord(user)) return undefined
  const blocks = typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined
  const last = blocks[blocks.length - 1]
  if (!isRecord(last)) return undefined

  // System markers are dropped by the plugin, so they do not count against the limit.
  const marked = [parsed.tools, parsed.messages.flatMap((message) => (isRecord(message) ? message.content : []))]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((block) => isRecord(block) && isRecord(block.cache_control))
  if (!isRecord(last.cache_control) && marked.length >= MAX_BREAKPOINTS) return undefined
  if (isRecord(last.cache_control) && last.cache_control.ttl === INTERACTIVE_TTL) return undefined

  // 1h entries must precede 5m ones: everything marked earlier in the prompt (tools) is
  // promoted too; later message markers stay at 5m.
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  tools.forEach((tool) => {
    if (isRecord(tool) && isRecord(tool.cache_control)) tool.cache_control = { ...tool.cache_control, ttl: INTERACTIVE_TTL }
  })
  last.cache_control = { type: "ephemeral", ttl: INTERACTIVE_TTL }
  user.content = blocks
  return JSON.stringify(parsed)
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

// models.dev prices cache writes at the 5-minute rate; 1-hour writes cost 2x input.
export function extraWriteCost(input: {
  metadata: Record<string, unknown> | undefined
  price: { input?: number; cache?: { write?: number } } | undefined
}) {
  const anthropic = input.metadata?.anthropic
  const usage = isRecord(anthropic) && isRecord(anthropic.usage) ? anthropic.usage : undefined
  const creation = usage && isRecord(usage.cache_creation) ? usage.cache_creation : undefined
  const tokens = typeof creation?.ephemeral_1h_input_tokens === "number" ? creation.ephemeral_1h_input_tokens : 0
  const base = input.price?.input ?? 0
  if (tokens === 0 || base === 0) return 0
  return (tokens * (2 * base - (input.price?.cache?.write ?? base * 1.25))) / 1_000_000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export * as ForkCache from "./cache"
