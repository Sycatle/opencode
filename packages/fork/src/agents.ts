// Multi-agent defaults of the fork.

// Marks fork binaries, e.g. to skip upstream auto-updates.
export const FORK_BUILD = true

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

// Searching does not need deep reasoning: those agents get the lowest effort variant
// the model offers, unless the agent sets its own variant.
const LOW_EFFORT_VARIANTS = ["minimal", "low", "none"]

export function defaultVariant(agent: { name: string; variant?: string }, available: string[]) {
  if (process.env.OPENCODE_FORK_SUBAGENT_EFFORT === "0") return undefined
  if (agent.variant !== undefined || !SMALL_MODEL_AGENTS.includes(agent.name)) return undefined
  return LOW_EFFORT_VARIANTS.find((name) => available.includes(name))
}

// Headless runs exit when the root session goes idle, which would kill background
// subagents still working. Their results are injected back into the root session,
// which then goes busy and idle again: exit on an idle with nothing pending.
export function backgroundTracker() {
  const pending = new Set<string>()
  // A fast child can go idle before its launching tool part is observed.
  const finished = new Set<string>()
  return {
    observePart(part: {
      type?: string
      tool?: string
      text?: string
      synthetic?: boolean
      state?: { status: string; metadata?: Record<string, unknown> }
    }) {
      // A workflow run has no session of its own: it is pending until its completion notice reaches the root.
      if (part.tool === "workflow" && part.state?.status === "completed") {
        const run = part.state.metadata?.runId
        if (typeof run === "string" && !finished.has(run)) pending.add(run)
        return
      }
      if (part.type === "text" && part.synthetic) {
        const run = part.text?.match(/^<workflow id="([^"]+)"/)?.[1]
        if (!run) return
        finished.add(run)
        pending.delete(run)
        return
      }
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

// `inherit: true` subagents start from a copy of the parent's conversation, with the
// parent's agent, tools and model, so their request shares the parent's cached prefix.
export function inheritEnabled() {
  return process.env.OPENCODE_FORK_SUBAGENT_INHERIT !== "0"
}

export const FORK_PREAMBLE = [
  "You are a forked worker: a copy of the agent above, started to do one delegated job.",
  "The conversation above is the parent's. Its in-progress work and its pending task call are not yours: do not redo them or continue the parent's plan.",
  "Do only the directive below, then reply with a concise report of what you did and found, without restating context the parent already has.",
].join(" ")

export function forkDirective(prompt: string) {
  return `${FORK_PREAMBLE}\n\nDirective: ${prompt}`
}

// Messages strictly before the one holding the pending task call. An unknown id
// yields nothing: seeding a child with the pending call would duplicate it.
export function historyBefore<T extends { info: { id: string } }>(messages: T[], messageID: string) {
  const end = messages.findIndex((message) => message.info.id === messageID)
  return end < 0 ? [] : messages.slice(0, end)
}

export * as ForkAgents from "./agents"
