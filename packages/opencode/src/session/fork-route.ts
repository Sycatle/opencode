import { ForkCache } from "@opencode-fork/core/cache"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { ForkQuota } from "@opencode-fork/core/quota"
import { ForkRoute } from "@opencode-fork/core/route"
import { ForkRouteLog } from "@opencode-fork/core/route-log"
import { Effect, Stream } from "effect"
import { Provider } from "@/provider/provider"
import { ForkRouteProvider } from "@/provider/fork-route"
import { LLM } from "./llm"
import { MessageID, SessionID } from "./schema"
import type { Session } from "./session"
import { SessionRetry } from "./retry"

// Router, session side. At each new user message of a router/* session the small model of the
// provider reads the prompt and a short summary and emits signals; the pure policy in
// @opencode-fork/core/route picks a tier and a concrete model; the choice is journaled in fork.db.
// Tool loops keep the model. A failure before the first streamed byte puts the model (or its
// provider) in cooldown and the turn is routed again (`failed`, called from the processor).

const health = ForkRoute.health()

type Turn = { candidates: string[]; attempts: number; excluded: Set<string>; error?: string }
const turns = new Map<string, Turn>()

const MAX_REROUTES = 4
// System prompt and tool definitions of a session that has not run a turn yet.
const FIXED_CONTEXT = 12_000
const SIGNALS_TIMEOUT = "20 seconds"

export type Resolved = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

export const routed = (user: SessionV1.User) => ForkRouteProvider.isRouter(user.model.providerID)

export const resolve = Effect.fn("ForkRouteTurn.resolve")(function* (input: {
  session: Session.Info
  user: SessionV1.User
  messages: SessionV1.WithParts[]
  assistant: SessionV1.Assistant | undefined
}) {
  const own: Resolved = { providerID: input.user.model.providerID, modelID: input.user.model.modelID }
  if (!routed(input.user)) return { model: own } as const

  const provider = yield* Provider.Service
  const mode = ForkRoute.parseMode(input.user.model.modelID) ?? ({ kind: "auto" } as const)
  const connected = Object.values(yield* provider.list()).filter((item) => !ForkRouteProvider.isRouter(item.id))
  const models = new Map<string, Provider.Model>(
    connected.flatMap((item) => Object.values(item.models).map((model) => [`${item.id}/${model.id}`, model] as const)),
  )
  const quota = ForkQuota.fresh("anthropic")
  const catalog = catalogOf(models, quota !== undefined)
  const now = Date.now()

  const done = ForkRouteLog.forMessage(input.session.id, input.user.id)
  const continuation = done !== undefined || input.assistant?.parentID === input.user.id
  const turn = turns.get(input.user.id) ?? { candidates: [], attempts: 0, excluded: new Set<string>() }
  const view = sessionView(input, catalog, done)

  const assistants = input.messages.flatMap((m) => (m.info.role === "assistant" && m.info.tokens ? [m.info] : []))
  const lastTurn = assistants.findLast((m) => m.tokens.input + m.tokens.cache.read + m.tokens.cache.write > 0)
  const prompt = textOf(input.messages.findLast((m) => m.info.id === input.user.id))
  const context = lastTurn
    ? lastTurn.tokens.input + lastTurn.tokens.cache.read + lastTurn.tokens.cache.write + lastTurn.tokens.output
    : FIXED_CONTEXT
  const tokens = context + Math.ceil(prompt.length / 4)

  // Over the subscription's 5-hour threshold (or rejected): its provider goes last, for new messages only.
  const window = quota?.five_hour
  const overQuota =
    !continuation &&
    window !== undefined &&
    window.reset > now &&
    (window.utilization >= ForkRoute.quotaThreshold(process.env.OPENCODE_FORK_ROUTE_QUOTA) ||
      quota?.status === "rejected")
  const degraded = new Set([...health.degraded(now), ...turn.excluded, ...(overQuota ? ["anthropic"] : [])])

  const needsClassify = mode.kind === "auto" && !continuation
  const signals = needsClassify
    ? yield* classify({
        provider,
        models,
        catalog,
        degraded,
        view,
        sessionID: input.session.id,
        prompt,
        tokens,
        messages: input.messages,
        user: input.user,
      })
    : undefined

  // Interactive sessions cache the stable prefix for an hour (seam cache-ttl), others for five minutes.
  const ttl = ForkCache.systemTtl() ? 60 * 60_000 : 5 * 60_000
  const recent = assistants.slice(-5)
  const choice = ForkRoute.choose(
    {
      mode,
      signals: signals ?? (needsClassify ? ForkRoute.unknown(ForkRoute.contextSize(tokens)) : undefined),
      continuation,
      session: view,
      tokens,
      needsTools: true,
      degraded,
      context,
      remaining: Number(process.env.OPENCODE_FORK_ROUTE_TURNS) || 6,
      output: recent.length ? recent.reduce((sum, m) => sum + m.tokens.output + m.tokens.reasoning, 0) / recent.length : 1500,
      cold: lastTurn?.time.completed !== undefined && now - lastTurn.time.completed > ttl,
      warm: Object.fromEntries(
        assistants
          .filter((m) => m.time.completed !== undefined && now - m.time.completed <= ttl)
          .map((m) => [
            `${m.providerID}/${m.modelID}`,
            m.tokens.input + m.tokens.cache.read + m.tokens.cache.write + m.tokens.output,
          ]),
      ),
    },
    catalog,
  )
  const real = choice ? models.get(choice.model) : undefined
  if (!choice || !real)
    return {
      error: `Router: no connected model can serve this request (~${tokens} tokens, router/${input.user.model.modelID}).`,
    } as const

  const resolved: Resolved = { providerID: real.providerID, modelID: real.id }
  turns.set(input.user.id, {
    ...turn,
    candidates: choice.candidates.map((c) => c.model),
  })
  trim()
  ForkRouteProvider.remember(input.user.model.modelID, { providerID: resolved.providerID, modelID: resolved.modelID })

  // A continuation that kept its model is not news; a new decision or a move to another model is.
  const moved = done !== undefined && `${done.provider_id}/${done.model_id}` !== choice.model
  if (continuation && !moved) return { model: resolved } as const
  ForkRouteLog.record({
    time: now,
    session_id: input.session.id,
    message_id: input.user.id,
    kind: moved ? "fallback" : "decision",
    mode: mode.kind === "auto" ? "auto" : mode.tier,
    tier: choice.tier,
    provider_id: real.providerID,
    model_id: real.id,
    previous: view ? view.model : undefined,
    reason: choice.reason,
    score: choice.score,
    signals,
    error: moved ? turn.error : undefined,
  })
  return { model: resolved } as const
})

function catalogOf(models: Map<string, Provider.Model>, subscription: boolean): ForkRoute.Catalog {
  const known = [...models].map(([id, model]): ForkRoute.Known => {
    return {
      id,
      provider: model.providerID,
      model: model.id,
      context: model.limit.context,
      tools: model.capabilities.toolcall && model.capabilities.output.text,
      price: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cache.read,
        cacheWrite: model.cost.cache.write,
      },
      reasoning: model.capabilities.reasoning,
      released: model.release_date,
      subscription: subscription && model.providerID === "anthropic",
    }
  })
  // `OPENCODE_FORK_ROUTE_TIERS` is JSON ({"fast": ["anthropic/claude-haiku-4-5"], ...}) rather than a config key:
  // the config schema is shared with the generated SDK and migrations, which would make every seam wider.
  const forced = ForkRoute.parseTiers(process.env.OPENCODE_FORK_ROUTE_TIERS) ?? {}
  const derived = ForkRoute.deriveTiers(known)
  const ids = new Set(known.map((m) => m.id))
  return {
    models: Object.fromEntries(known.map((m) => [m.id, m])),
    tiers: Object.fromEntries(
      ForkRoute.TIERS.map((tier) => [tier, forced[tier]?.filter((id) => ids.has(id)) ?? derived[tier]]),
    ) as Record<ForkRoute.Tier, string[]>,
  }
}

// Where the session stands: the journal first, then the last assistant message of a session
// whose earlier turns ran on a model picked by hand. A new session or a subagent has no view.
function sessionView(
  input: { session: Session.Info; assistant: SessionV1.Assistant | undefined },
  catalog: ForkRoute.Catalog,
  done: ForkRouteLog.Row | undefined,
): ForkRoute.SessionView | undefined {
  const history = ForkRouteLog.decisions(input.session.id, 3)
  const latest = done ?? ForkRouteLog.latest(input.session.id)
  if (latest)
    return {
      tier: (history[0] ?? latest).tier,
      model: `${latest.provider_id}/${latest.model_id}`,
      provider: latest.provider_id,
      history: history.map((row) => row.tier).toReversed(),
    }
  const last = input.assistant
  if (input.session.parentID || !last || ForkRouteProvider.isRouter(last.providerID)) return undefined
  const id = `${last.providerID}/${last.modelID}`
  const tier = ForkRoute.TIERS.findLast((t) => catalog.tiers[t].includes(id)) ?? "standard"
  return { tier, model: id, provider: last.providerID, history: [] }
}

function textOf(message: SessionV1.WithParts | undefined) {
  return (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
}

const classify = Effect.fn("ForkRouteTurn.classify")(function* (input: {
  provider: Provider.Interface
  models: Map<string, Provider.Model>
  catalog: ForkRoute.Catalog
  degraded: ReadonlySet<string>
  view: ForkRoute.SessionView | undefined
  sessionID: string
  prompt: string
  tokens: number
  messages: SessionV1.WithParts[]
  user: SessionV1.User
}) {
  // The small model of the provider the turn is most likely to run on.
  const home =
    input.view?.model ??
    input.catalog.tiers.standard.find((id) => !input.degraded.has(id)) ??
    input.catalog.tiers.standard[0]
  const base = input.models.get(home ?? "")
  if (!base) return undefined
  const first = input.messages.find((m) => m.info.role === "user")
  const lastAnswer = input.messages.findLast((m) => m.info.role === "assistant")
  const summary: ForkRoute.Summary = {
    first: first && first.info.id !== input.user.id ? textOf(first) : undefined,
    messages: input.messages.length,
    tokens: input.tokens,
    lastAnswer: textOf(lastAnswer) || undefined,
  }
  const text = yield* ask(input.provider, base, ForkRoute.signalsPrompt(input.prompt, summary)).pipe(
    Effect.timeout(SIGNALS_TIMEOUT),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  return text === undefined ? undefined : ForkRoute.parseSignals(text, ForkRoute.contextSize(input.tokens))
})

// One-shot completion on the small model of the provider (same call path as the prompt hooks of
// plugin/fork-hooks-model.ts, here from inside the session layer).
const ask = Effect.fn("ForkRouteTurn.ask")(function* (provider: Provider.Interface, base: Provider.Model, prompt: string) {
  const llm = yield* LLM.Service
  const model = (yield* provider.getSmallModel(base.providerID)) ?? base
  const agent = { name: "fork-route", mode: "primary" as const, permission: [], options: {}, native: true, prompt: "" }
  return yield* llm
    .stream({
      agent,
      user: {
        id: MessageID.ascending(),
        sessionID: SessionID.descending(),
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
      },
      system: [],
      small: true,
      tools: {},
      model,
      sessionID: SessionID.descending(),
      retries: 1,
      messages: [{ role: "user", content: prompt }],
    })
    .pipe(
      Stream.filter(LLMEvent.is.textDelta),
      Stream.map((part) => part.text),
      Stream.mkString,
    )
})

// ---------------------------------------------------------------- fallback

// Signals the processor that this attempt must be routed again (never reaches the user).
export const REROUTE = new Error("fork-route-reroute")

// An event that carries model output: from then on the turn cannot move to another model.
export const output = (type: string) => /^(text|reasoning|tool)-/.test(type)

// A provider call of a router/* turn failed before streaming anything. Puts the model (or its
// provider, when quota or credits ran out) in cooldown and returns true when the turn should be
// routed again because another candidate is left. Otherwise the session's own retry and error
// handling apply, as for any model.
export function failed(input: { user: SessionV1.User; model: Provider.Model; error: SessionRetry.Err }) {
  if (!routed(input.user)) return false
  const turn = turns.get(input.user.id)
  if (!turn || turn.attempts >= MAX_REROUTES) return false
  const failure = failureOf(input.error, input.model.providerID)
  if (!failure) return false
  const id = `${input.model.providerID}/${input.model.id}`
  health.record({ id, provider: input.model.providerID }, failure, Date.now())
  turn.excluded.add(id)
  turn.attempts++
  turn.error = `${id}: ${failure.kind}`
  const open = health.degraded(Date.now())
  const alternative = turn.candidates.some(
    (candidate) => !turn.excluded.has(candidate) && !open.has(candidate) && !open.has(candidate.split("/")[0]),
  )
  return alternative
}

function failureOf(error: SessionRetry.Err, provider: string) {
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const headers = error.data.responseHeaders ?? {}
    const ms = Number.parseFloat(headers["retry-after-ms"] ?? "")
    const seconds = Number.parseFloat(headers["retry-after"] ?? "")
    return ForkRoute.classify({
      status: error.data.statusCode,
      message: `${error.data.message} ${error.data.responseBody ?? ""}`,
      retryAfterMs: Number.isFinite(ms) ? ms : Number.isFinite(seconds) ? seconds * 1000 : undefined,
    })
  }
  // Network errors and the like: whatever the session would retry is a transient failure here.
  return SessionRetry.retryable(error, provider) ? ({ kind: "transient" } as const) : undefined
}

// The router model a subagent of this session should run on, when the session's current turn is routed:
// the subagent is a new session, so it starts from the tier its own prompt calls for.
export function subagent(sessionID: string, running: { providerID: string; modelID: string }) {
  const row = ForkRouteLog.latest(sessionID)
  if (!row || row.provider_id !== running.providerID || row.model_id !== running.modelID) return undefined
  return { providerID: ForkRouteProvider.ID, modelID: row.mode }
}

function trim() {
  if (turns.size <= 200) return
  const oldest = turns.keys().next().value
  if (oldest !== undefined) turns.delete(oldest)
}

export * as ForkRouteTurn from "./fork-route"
