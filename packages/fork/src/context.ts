import type { ForkJev } from "./jev"

// Prune is on by default in the fork: old tool outputs are cleared in batches
// (upstream thresholds), which keeps the prompt cache valid between batches.
export function pruneEnabled(configured: boolean | undefined) {
  return configured !== false
}

// Replaces upstream's opaque "[Old tool result content cleared]" so the model knows
// what was there and whether re-running the tool is worth it.
export function prunedStub(part: { tool: string; state: { title?: string; output: string } }) {
  const lines = part.state.output.split("\n").length
  const title = part.state.title ? ` ${part.state.title}` : ""
  return `[Old result of ${part.tool}${title} cleared (${lines} lines). Re-run the tool if you need it again.]`
}

// Upstream keeps 2000 lines / 50 KB (~12k tokens) of every tool output in context.
// The full output is still written to disk with a pointer, so the model can grep it.
// Same bytes-per-line ratio as upstream, so the byte limit still wins on dense output.
export const TOOL_OUTPUT = { maxLines: 640, maxBytes: 16 * 1024 }

const PRUNE_ASKED = 20
const PRUNE_EXCERPT = 300
const PRUNE_KEEP_AT = 0.8
const PRUNE_KEEP_SHARE = 0.25

export type PruneItem = { id: string; tool: string; title: string; excerpt: string; tokens: number }

// The largest outputs of a prune batch, one Jev question each, with the user's current request.
export function pruneAsk(batch: readonly PruneItem[]) {
  return batch.toSorted((a, b) => b.tokens - a.tokens).slice(0, PRUNE_ASKED)
}

export function pruneRequest(items: readonly PruneItem[], user: string) {
  return {
    state: [
      "Old tool outputs about to be removed from a coding agent's context. Decide for each whether the agent will still need it to finish the current request.",
      `Current request:\n${user.trim().slice(0, 600)}`,
      ...items.map((item, index) => `[p${index}] ${item.tool} ${item.title}\n${item.excerpt.slice(0, PRUNE_EXCERPT)}`),
    ].join("\n\n"),
    questions: Object.fromEntries(
      items.map((_, index) => [
        `p${index}`,
        { type: "noul" as const, instructions: `Output [p${index}] will be needed again to finish the current request` },
      ]),
    ) satisfies Record<string, ForkJev.Question>,
  }
}

// The outputs to keep: from the threshold, at most a quarter of the batch, and only while the rest still
// makes a batch worth pruning (`minimum` tokens), so a prune never becomes a no-op that repeats every turn.
export function pruneKeeps(
  items: readonly PruneItem[],
  answers: Record<string, ForkJev.Answer>,
  batch: { count: number; tokens: number },
  minimum: number,
) {
  const likely = items
    .flatMap((item, index) => {
      const noul = answers[`p${index}`]?.noul
      return noul !== undefined && noul >= PRUNE_KEEP_AT ? [{ item, noul }] : []
    })
    .toSorted((a, b) => b.noul - a.noul)
    .slice(0, Math.floor(batch.count * PRUNE_KEEP_SHARE))
  const kept = likely.reduce((sum, entry) => sum + entry.item.tokens, 0)
  return new Set(batch.tokens - kept > minimum ? likely.map((entry) => entry.item.id) : [])
}

export * as ForkContext from "./context"
