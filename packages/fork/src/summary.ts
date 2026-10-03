import type { ForkTelemetry } from "./telemetry"

// Display-ready aggregates for the TUI widgets.

export type Breakdown = { system: number; tools: number; history: number; tool_output: number }

export function summarize(steps: readonly ForkTelemetry.Step[], sessionID: string) {
  const own = steps.filter((step) => step.session_id === sessionID)
  const last = own.at(-1)
  const inputSide = (step: ForkTelemetry.Step) => step.input + step.cache_read + step.cache_write
  const totalInput = steps.reduce((sum, step) => sum + inputSide(step), 0)
  return {
    last: last
      ? {
          context: inputSide(last),
          cost: last.cost,
          cacheHit: ratio(last.cache_read, inputSide(last)),
          breakdown: {
            system: last.est_system,
            tools: last.est_tools,
            history: last.est_history,
            tool_output: last.est_tool_output,
          } satisfies Breakdown,
        }
      : undefined,
    turns: own.length,
    cost: steps.reduce((sum, step) => sum + step.cost, 0),
    cacheHit: ratio(
      steps.reduce((sum, step) => sum + step.cache_read, 0),
      totalInput,
    ),
    children: [...new Set(steps.map((step) => step.session_id))]
      .filter((id) => id !== sessionID)
      .map((id) => {
        const rows = steps.filter((step) => step.session_id === id)
        return {
          sessionID: id,
          agent: rows[0]?.agent ?? "unknown",
          model: rows.at(-1)?.model_id ?? "",
          turns: rows.length,
          cost: rows.reduce((sum, step) => sum + step.cost, 0),
        }
      }),
  }
}

// Share of each category, rounded so the parts add up to 100.
export function shares(value: Breakdown) {
  const total = value.system + value.tools + value.history + value.tool_output
  if (total === 0) return undefined
  const raw = Object.entries(value).map(([key, part]) => [key, (part / total) * 100] as const)
  const floored = raw.map(([key, part]) => [key, Math.floor(part)] as const)
  const missing = 100 - floored.reduce((sum, [, part]) => sum + part, 0)
  const order = raw
    .map(([key, part], index) => ({ key, index, rest: part - Math.floor(part) }))
    .toSorted((a, b) => b.rest - a.rest)
    .slice(0, missing)
    .map((item) => item.index)
  return Object.fromEntries(
    floored.map(([key, part], index) => [key, part + (order.includes(index) ? 1 : 0)]),
  ) as Breakdown
}

export function budgetLevel(spent: number, limit: number | undefined) {
  if (limit === undefined) return undefined
  const used = spent / limit
  if (used >= 1) return "exceeded" as const
  if (used >= 0.8) return "warning" as const
  return "ok" as const
}

function ratio(part: number, total: number) {
  return total === 0 ? undefined : part / total
}

export * as ForkSummary from "./summary"
