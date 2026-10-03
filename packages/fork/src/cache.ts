// Prompt cache TTL for the stable prefix (tools + system prompt) on Anthropic.
// The default 5-minute cache expires during human pauses, and the whole prefix is
// then written again at 1.25x. A 1-hour write costs 2x once but survives pauses
// and is shared by later sessions of the same project. Interactive sessions use it;
// headless runs, which chain turns without pauses, keep 5 minutes.

export const INTERACTIVE_TTL = "1h"

export function systemTtl() {
  return process.env.OPENCODE_FORK_CACHE_TTL === "1h" ? ("1h" as const) : undefined
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
