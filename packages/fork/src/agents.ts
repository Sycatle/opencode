// Multi-agent defaults of the fork.

// Background subagents ship behind OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
// upstream; the fork enables them unless that variable is explicitly false.
export const BACKGROUND_DEFAULT = true

// Nested subagents still need an agent whose permissions allow `task`.
export const SUBAGENT_DEPTH = 2

export function maxBackground() {
  const value = Number(process.env.OPENCODE_FORK_MAX_BACKGROUND)
  return Number.isInteger(value) && value > 0 ? value : 4
}

// Read-only search agents do not need the main model: they run on the provider's
// small model unless the agent pins a model in config.
const SMALL_MODEL_AGENTS = ["explore"]

export function routeToSmallModel(agent: { name: string; model?: unknown }) {
  if (process.env.OPENCODE_FORK_ROUTE_SUBAGENTS === "0") return false
  return agent.model === undefined && SMALL_MODEL_AGENTS.includes(agent.name)
}

// Headless runs exit when the root session goes idle, which would kill background
// subagents still working. Their results are injected back into the root session,
// which then goes busy and idle again: exit on an idle with nothing pending.
export function backgroundTracker() {
  const pending = new Set<string>()
  // A fast child can go idle before its launching tool part is observed.
  const finished = new Set<string>()
  return {
    observePart(part: { tool?: string; state?: { status: string; metadata?: Record<string, unknown> } }) {
      if (part.tool !== "task" || part.state?.status !== "completed") return
      const child = part.state.metadata?.sessionId
      if (part.state.metadata?.background !== true || typeof child !== "string") return
      if (!finished.has(child)) pending.add(child)
    },
    observeIdle(sessionID: string) {
      finished.add(sessionID)
      pending.delete(sessionID)
    },
    canExit() {
      return pending.size === 0
    },
  }
}

export * as ForkAgents from "./agents"
