import { ForkTelemetry } from "./telemetry"
import { ForkQuota } from "./quota"

// Session budget in USD, shared by a session and all of its subagents.
// At the limit the agent gets one wrap-up turn without tools; if it keeps going
// past the hard margin the loop stops.
const HARD_MARGIN = 1.2

export const PROMPT = `CRITICAL - BUDGET REACHED

The cost budget allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

Do NOT make any tool calls. Provide a text response with:
- Statement that the budget for this task has been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next`

export function limit() {
  const value = Number(process.env.OPENCODE_FORK_BUDGET_USD)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

// Subscription budget: percentage points of the 5-hour window, e.g. 20.
export function windowLimit() {
  const value = Number(process.env.OPENCODE_FORK_BUDGET_WINDOW)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

type Result =
  | { state: "ok"; spent?: number; max?: number; unit?: "usd" | "window" }
  | { state: "wrap-up" | "stop"; spent: number; max: number; unit: "usd" | "window" }

// The stricter of the dollar and the window budget applies.
export function check(session: { id: string; parentID?: string }): Result {
  const usd = limit()
  const window = windowLimit()
  if (usd === undefined && window === undefined) return { state: "ok" }
  const root = ForkTelemetry.rootOf(session.parentID ?? session.id)
  const results = [
    usd === undefined ? undefined : evaluate(ForkTelemetry.treeCost(root), usd, "usd"),
    window === undefined ? undefined : evaluate(ForkQuota.windowSpent(root) ?? 0, window, "window"),
  ].filter((item) => item !== undefined)
  const rank = { ok: 0, "wrap-up": 1, stop: 2 }
  return results.toSorted((a, b) => rank[b.state] - rank[a.state])[0]
}

export function describe(result: { spent: number; max: number; unit: "usd" | "window" }) {
  return result.unit === "usd"
    ? `$${result.spent.toFixed(2)} spent of $${result.max.toFixed(2)}`
    : `${result.spent} points of the 5-hour window used of ${result.max}`
}

function evaluate(spent: number, max: number, unit: "usd" | "window") {
  if (spent >= max * HARD_MARGIN) return { state: "stop" as const, spent, max, unit }
  if (spent >= max) return { state: "wrap-up" as const, spent, max, unit }
  return { state: "ok" as const, spent, max, unit }
}

export * as ForkBudget from "./budget"
