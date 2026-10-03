import { writeCost, type Price } from "./route"

// When to compact. Upstream compacts at overflow, usually in the middle of a tool loop. This policy
// decides at the end of an assistant turn (the session is about to go idle), or at the start of the
// next one when the cache went cold, whether compacting now beats waiting. It is pure: the session
// glue (session/fork-smart-compaction.ts) gathers the inputs and runs the existing compaction path.
// Overflow compaction stays the safety net.

export const COMPACT_AT = 0.5
export const COLD_AT = 0.3
export const MIN_TURNS = 3
// Estimated size of a summary (output tokens of the summary turn, and its size in the new prefix).
export const SUMMARY_TOKENS = 2_000
// Anthropic cache TTL without the 1h option, minus a margin (see compaction.ts WARM_MS).
export const WARM_TTL_MS = 4.5 * 60 * 1000
export const LONG_TTL_MS = 55 * 60 * 1000

export function enabled() {
  return process.env.OPENCODE_FORK_SMART_COMPACTION !== "0"
}

export type Settings = { at: number; coldAt: number; minTurns: number }

export function settings(): Settings {
  return {
    at: ratio(process.env.OPENCODE_FORK_COMPACT_AT, COMPACT_AT),
    coldAt: ratio(process.env.OPENCODE_FORK_COMPACT_COLD_AT, COLD_AT),
    minTurns: count(process.env.OPENCODE_FORK_COMPACT_MIN_TURNS, MIN_TURNS),
  }
}

// "0.5" and "50" both mean half of the window.
function ratio(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  if (!value || !Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed > 1 ? parsed / 100 : parsed, 1)
}

function count(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return value && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export type Phase = "end" | "start"

export type Input = {
  // "end": the assistant turn just finished. "start": a new turn is about to call the model.
  phase: Phase
  // Tokens of the last request (input + cache read + cache write).
  context: number
  // Context window of the model.
  window: number
  // Stable prefix that survives a compaction (system prompt, tools, first message), in tokens.
  base: number
  // Recent messages a compaction keeps verbatim, in tokens.
  tail: number
  // Prices per million tokens, from models.dev.
  price: Price
  // Time since the last provider response, and how long the prompt cache lives.
  idleMs: number
  ttlMs: number
  // The last assistant message asked for tools (a loop is running or was interrupted).
  toolLoop: boolean
  todos: readonly { status: string }[]
  // A subagent or a background job of this session is running.
  background: boolean
  // The plan agent runs and has not called plan_exit.
  planMode: boolean
  // User turns since the last compaction (Infinity when there was none).
  turnsSince: number
  // Provider calls expected before the session ends.
  remaining: number
}

export type Code =
  | "tool-loop"
  | "background"
  | "plan-mode"
  | "recent-compaction"
  | "no-window"
  | "warm"
  | "task-open"
  | "below-threshold"
  | "no-price"
  | "not-worth"
  | "boundary"
  | "cold-cache"

export type Decision = {
  compact: boolean
  code: Code
  reason: string
  cold: boolean
  context: number
  window: number
  threshold: number
  cost: number
  benefit: number
}

export function decide(input: Input, cfg: Settings = settings()): Decision {
  const cold = input.idleMs > input.ttlMs
  const threshold = cold ? Math.min(cfg.coldAt, cfg.at) : cfg.at
  const base = { cold, context: input.context, window: input.window, threshold, cost: 0, benefit: 0 }
  const skip = (code: Code, reason: string, extra: Partial<Decision> = {}): Decision => ({
    ...base,
    ...extra,
    compact: false,
    code,
    reason,
  })

  if (input.toolLoop) return skip("tool-loop", "a tool loop is running")
  if (input.background) return skip("background", "a subagent or background job of this session is running")
  if (input.planMode) return skip("plan-mode", "plan mode, before plan_exit")
  if (input.turnsSince < cfg.minTurns)
    return skip("recent-compaction", `last compaction ${input.turnsSince} turn(s) ago, minimum ${cfg.minTurns}`)
  if (input.window <= 0) return skip("no-window", "the model window is unknown")
  if (input.phase === "start" && !cold) return skip("warm", "warm cache, decided at the end of the turn")
  const open = input.todos.filter((todo) => todo.status !== "completed").length
  if (input.phase === "end" && open > 0) return skip("task-open", `${open} todo item(s) still open`)

  const used = input.context / input.window
  if (used < threshold)
    return skip("below-threshold", `${pct(used)} of the window, ${cold ? "cold-cache " : ""}threshold ${pct(threshold)}`)

  const money = pays(input, cold)
  const detail = `${pct(used)} of the window, benefit ${usd(money.benefit)} vs cost ${usd(money.cost)}`
  const figures = { cost: money.cost, benefit: money.benefit }
  if (money.free) return skip("no-price", "the model has no known price", figures)
  if (!money.pays) return skip("not-worth", `${detail}: not worth it`, figures)
  return {
    ...base,
    ...figures,
    compact: true,
    code: cold ? "cold-cache" : "boundary",
    reason: cold ? `cold cache, the next turn rewrites the context anyway: ${detail}` : `task boundary: ${detail}`,
  }
}

// Cost of compacting against what it saves, like downgradePays in route.ts.
// Warm: the summary turn reads the context from the cache, then the summary and the kept tail are
// written (the stable prefix stays cached). Cold: the summary reads the context at the input price
// and the whole new prefix is written, but the next turn would have rewritten the old context.
export function pays(input: Input, cold: boolean) {
  const price = input.price
  const compacted = Math.min(input.context, input.base + SUMMARY_TOKENS + input.tail)
  const saved = input.context - compacted
  const million = 1_000_000
  const summaryTurn = (input.context * (cold ? price.input : price.cacheRead) + SUMMARY_TOKENS * price.output) / million
  const cost = summaryTurn + writeCost(price, cold ? compacted : Math.max(0, compacted - input.base))
  const benefit = (saved * price.cacheRead * input.remaining) / million + (cold ? writeCost(price, input.context) : 0)
  const free = price.input + price.cacheRead + price.output + price.cacheWrite === 0
  return { cost, benefit, free, pays: benefit > cost }
}

const MIN_REMAINING = 3
const MAX_REMAINING = 40

// Provider calls still to come, from how many a user prompt has needed so far.
export function remainingTurns(prompts: number, calls: number) {
  return Math.min(MAX_REMAINING, Math.max(MIN_REMAINING, Math.round(calls / Math.max(1, prompts))))
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

function usd(value: number) {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

export * as ForkCompactionTiming from "./compaction-timing"
