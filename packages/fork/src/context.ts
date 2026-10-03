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

export * as ForkContext from "./context"
