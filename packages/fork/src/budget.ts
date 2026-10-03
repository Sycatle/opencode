import { ForkTelemetry } from "./telemetry"

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

export function check(session: { id: string; parentID?: string }) {
  const max = limit()
  if (max === undefined) return { state: "ok" as const }
  const spent = ForkTelemetry.treeCost(ForkTelemetry.rootOf(session.parentID ?? session.id))
  if (spent >= max * HARD_MARGIN) return { state: "stop" as const, spent, max }
  if (spent >= max) return { state: "wrap-up" as const, spent, max }
  return { state: "ok" as const, spent, max }
}

export * as ForkBudget from "./budget"
