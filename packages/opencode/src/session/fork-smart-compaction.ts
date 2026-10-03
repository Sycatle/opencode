import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ForkCache } from "@opencode-fork/core/cache"
import { ForkCompaction } from "@opencode-fork/core/compaction"
import { ForkJev } from "@opencode-fork/core/jev"
import { ForkCompactionLog } from "@opencode-fork/core/compaction-log"
import { ForkCompactionTiming } from "@opencode-fork/core/compaction-timing"
import { Effect, Option } from "effect"
import type { BackgroundJob } from "@/background/job"
import type { Provider } from "@/provider/provider"

// Fork-owned glue for packages/fork/src/compaction-timing.ts (see docs/fork/seams.md): gathers what
// the pure policy needs from the session, journals the decision, and answers whether to compact now.
// The caller runs the existing compaction path (`SessionCompaction.create`), cached summary included.

// Upstream keeps between 2k and 15k tokens of recent messages (a quarter of the window in between).
const MIN_TAIL = 2_000
const MAX_TAIL = 15_000

export type CheckInput = {
  phase: ForkCompactionTiming.Phase
  sessionID: string
  // A subagent session is discarded by its parent, summarizing it is wasted.
  parentID?: string
  messages: SessionV1.WithParts[]
  provider: Provider.Interface
  user: SessionV1.User
  // The last assistant message that finished.
  assistant: SessionV1.Assistant | undefined
  background: BackgroundJob.Interface
}

export const check = Effect.fn("ForkSmartCompaction.check")(function* (input: CheckInput) {
  const assistant = input.assistant
  if (!ForkCompactionTiming.enabled() || input.parentID || !assistant || assistant.summary || assistant.error)
    return false

  // The model that answered last: it holds the cache and sets the prices (a router/* user model is virtual).
  const model = yield* input.provider.getModel(assistant.providerID, assistant.modelID).pipe(Effect.option)
  if (Option.isNone(model)) return false
  const running = yield* input.background.list()
  const state = snapshot(input, model.value, assistant, jobsOf(input.sessionID, running))
  const first = ForkCompactionTiming.decide(state)
  const decision = first.compact && first.code === "boundary" ? yield* confirmBoundary(input, state, first) : first
  // Every turn start runs the check; only the ones that can act are worth a row.
  if (input.phase === "start" && decision.code === "warm") return false
  ForkCompactionLog.record({ sessionID: input.sessionID, messageID: assistant.id, phase: input.phase, decision })
  return decision.compact
})

// Jev can only delay a compaction that waits for a task boundary, never bring one forward: the ones that
// the cold cache or the overflow force are not asked. In shadow mode Jev answers but the first decision stands.
const confirmBoundary = Effect.fn("ForkSmartCompaction.boundary")(function* (
  input: CheckInput,
  state: ForkCompactionTiming.Input,
  first: ForkCompactionTiming.Decision,
) {
  const mode = ForkJev.mode("SMART_COMPACTION")
  if (mode === "off") return first
  const text = (role: "user" | "assistant") =>
    (input.messages.findLast((message) => message.info.role === role)?.parts ?? [])
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("\n")
  const response = yield* Effect.promise(() =>
    ForkJev.ask(
      ForkCompactionTiming.jevRequest({
        user: text("user"),
        reply: text("assistant"),
        todos: state.todos.filter((todo) => todo.status !== "completed").length,
      }),
    ),
  )
  const boundary = response.answers?.boundary?.noul
  const second = boundary === undefined ? first : ForkCompactionTiming.decide({ ...state, boundary })
  ForkJev.journal({
    feature: "smart_compaction",
    session_id: input.sessionID,
    ms: response.ms,
    ok: boundary !== undefined,
    error: response.error ?? (boundary === undefined ? "Jev response unusable" : undefined),
    decision: second.compact ? "compact" : "delay",
    other: mode === "shadow" ? "compact" : undefined,
    answers: response.answers,
  })
  return mode === "shadow" ? first : second
})

function snapshot(
  input: CheckInput,
  model: Provider.Model,
  assistant: SessionV1.Assistant,
  background: boolean,
): ForkCompactionTiming.Input {
  const window = model.limit.context
  const cost = model.cost
  const assistants = input.messages.flatMap((message) =>
    message.info.role === "assistant" && !message.info.summary ? [message.info] : [],
  )
  const lastSummary = input.messages.findLastIndex((message) => message.info.role === "assistant" && message.info.summary)
  const prompts = (messages: SessionV1.WithParts[]) =>
    messages.filter(
      (message) =>
        message.info.role === "user" &&
        message.parts.some((part) => part.type !== "compaction" && !(part.type === "text" && part.synthetic)),
    ).length
  const sizes = assistants.map(contextOf).filter((tokens) => tokens > 0)
  const lastMessage = input.messages.findLast((message) => message.info.id === assistant.id)
  return {
    phase: input.phase,
    context: contextOf(assistant),
    window,
    // The smallest context the session ever sent: system prompt, tools and the first message.
    base: sizes.length ? Math.min(...sizes) : 0,
    tail: Math.min(MAX_TAIL, Math.max(MIN_TAIL, Math.floor(window * 0.25))),
    price: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cache?.read ?? cost.input,
      cacheWrite: cost.cache?.write ?? cost.input,
    },
    idleMs: Date.now() - (assistant.time.completed ?? assistant.time.created),
    ttlMs: ForkCache.systemTtl() ? ForkCompactionTiming.LONG_TTL_MS : ForkCompactionTiming.WARM_TTL_MS,
    toolLoop:
      ["tool-calls", "unknown"].includes(assistant.finish ?? "") ||
      (lastMessage?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false),
    todos: ForkCompaction.facts(input.messages).todos,
    background,
    planMode: input.user.agent === "plan",
    turnsSince: lastSummary === -1 ? Infinity : prompts(input.messages.slice(lastSummary + 1)),
    remaining: ForkCompactionTiming.remainingTurns(prompts(input.messages), assistants.length),
  }
}

function contextOf(assistant: SessionV1.Assistant) {
  const tokens = assistant.tokens
  return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output
}

// A running job belongs to the session when it is its subagent or shell job, or a descendant of one.
function jobsOf(sessionID: string, jobs: readonly BackgroundJob.Info[]) {
  const live = jobs.filter((job) => job.status === "running")
  const owners = (known: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set([
      ...known,
      ...live.flatMap((job) => {
        const owner = job.metadata?.parentSessionId ?? job.metadata?.sessionId
        return typeof owner === "string" && known.has(owner) ? [job.id, String(job.metadata?.sessionId ?? job.id)] : []
      }),
    ])
    return next.size === known.size ? known : owners(next)
  }
  const mine = owners(new Set([sessionID]))
  return live.some((job) => mine.has(job.id))
}

export * as ForkSmartCompaction from "./fork-smart-compaction"
