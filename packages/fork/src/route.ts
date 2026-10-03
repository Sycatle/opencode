// Router: model routing policy, ported from llm-router (Rust). Pure and deterministic:
// no I/O, and the clock is always a parameter. A small model only emits signals; this module
// turns signals + session + catalog + health into a tier and an ordered list of candidates.
// The fork adds a cache-aware switch: leaving a model mid-session rewrites the whole cached
// context, so a downgrade must save more than that rewrite costs (`choose`).

export const TIERS = ["fast", "standard", "reasoning", "frontier"] as const
export type Tier = (typeof TIERS)[number]

export const TASK_TYPES = [
  "question",
  "repo_search",
  "small_edit",
  "feature",
  "debugging",
  "refactor",
  "architecture",
  "tests",
  "docs",
  "other",
] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const CONTEXT_SIZES = ["small", "medium", "large", "huge"] as const
export type ContextSize = (typeof CONTEXT_SIZES)[number]

export function contextSize(tokens: number): ContextSize {
  if (tokens < 8_000) return "small"
  if (tokens < 40_000) return "medium"
  if (tokens < 120_000) return "large"
  return "huge"
}

export type Signals = {
  task_type: TaskType
  complexity: number
  reasoning: number
  tool_intensity: number
  latency_sensitivity: number
  ambiguity: number
  context_size: ContextSize
  confidence: number
  // Who produced the signals (journal only; the policy ignores it).
  // "reused": a short follow-up kept the signals of the previous message (`shouldReclassify`).
  source?: "jev" | "small-model" | "reused"
}

// Neutral signals for an unavailable classifier: confidence 0 holds the tier (or STANDARD).
export function unknown(size: ContextSize): Signals {
  return {
    task_type: "other",
    complexity: 0.5,
    reasoning: 0.5,
    tool_intensity: 0.5,
    latency_sensitivity: 0.5,
    ambiguity: 0,
    context_size: size,
    confidence: 0,
  }
}

export type Config = {
  // Distance (in score units) beyond the current tier band required to switch tier.
  stickiness: number
  // Larger distance when the switch would reverse a recent one (anti-flapping).
  switch_threshold: number
  // Below this confidence the policy holds the current tier (or STANDARD).
  min_confidence: number
  // Score boundaries: fast|standard, standard|reasoning, reasoning|frontier.
  thresholds: readonly [number, number, number]
}

export const DEFAULTS: Config = {
  stickiness: 0.15,
  switch_threshold: 0.2,
  min_confidence: 0.4,
  thresholds: [0.3, 0.55, 0.8],
}

const OUTPUT_RESERVE_TOKENS = 1024

// ---------------------------------------------------------------- modes

export type Mode = { kind: "auto" } | { kind: "tier"; tier: Tier }

// Model ID of the virtual provider: "auto", "fast", "standard", "reasoning", "frontier".
export function parseMode(modelID: string): Mode | undefined {
  const id = modelID.trim().toLowerCase().replace(/^auto-/, "")
  if (id === "auto") return { kind: "auto" }
  const tier = TIERS.find((item) => item === id)
  return tier ? { kind: "tier", tier } : undefined
}

export const MODEL_IDS = ["auto", ...TIERS] as const

// ---------------------------------------------------------------- score

export function score(s: Signals) {
  const task =
    s.task_type === "architecture"
      ? 0.1
      : s.task_type === "debugging" || s.task_type === "refactor"
        ? 0.05
        : s.task_type === "question" ||
            s.task_type === "repo_search" ||
            s.task_type === "small_edit" ||
            s.task_type === "docs"
          ? -0.05
          : 0
  const size = s.context_size === "large" ? 0.05 : s.context_size === "huge" ? 0.15 : 0
  const value =
    0.4 * s.reasoning +
    0.3 * s.complexity +
    0.15 * s.tool_intensity +
    0.15 * s.ambiguity +
    task +
    size -
    0.1 * s.latency_sensitivity
  return Math.min(1, Math.max(0, value))
}

function band(tier: Tier, cfg: Config): [number, number] {
  const t = cfg.thresholds
  if (tier === "fast") return [Number.NEGATIVE_INFINITY, t[0]]
  if (tier === "standard") return [t[0], t[1]]
  if (tier === "reasoning") return [t[1], t[2]]
  return [t[2], Number.POSITIVE_INFINITY]
}

export function tierOfScore(value: number, cfg: Config = DEFAULTS): Tier {
  return TIERS.find((tier) => value < band(tier, cfg)[1]) ?? "frontier"
}

function distanceFromBand(value: number, tier: Tier, cfg: Config) {
  const [lo, hi] = band(tier, cfg)
  if (value < lo) return lo - value
  if (value >= hi) return value - hi
  return 0
}

export const rank = (tier: Tier) => TIERS.indexOf(tier)

// ---------------------------------------------------------------- refinements around the policy

type Env = Record<string, string | undefined>

const RECLASSIFY_MAX_AGE_MS = 30 * 60_000
const RECLASSIFY_CONFIDENCE = 0.6
const SHORT_CHARS = 80
const SHORT_WORDS = 12

// A short follow-up ("ok, go on", "run the tests") keeps the signals of the previous message, as long as that
// classification was confident and recent. The first message of a session is always classified.
// OPENCODE_FORK_ROUTE_RECLASSIFY=0 classifies every message.
export function shouldReclassify(
  i: { prompt: string; previous?: { signals: Signals; time: number }; now: number },
  env: Env = process.env,
) {
  if (!ForkFlags.on("ROUTE_RECLASSIFY", env)) return true
  if (!i.previous) return true
  if (i.now - i.previous.time > RECLASSIFY_MAX_AGE_MS) return true
  if (i.previous.signals.confidence < RECLASSIFY_CONFIDENCE) return true
  const text = i.prompt.trim()
  return text.length > SHORT_CHARS && text.split(/\s+/).length > SHORT_WORDS
}

// Signals read back from a journal row (`fork_route.signals`); undefined when a field is missing or off.
export function readSignals(value: unknown): Signals | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const fields = Object.fromEntries(Object.entries(value))
  const number = (key: string) => (typeof fields[key] === "number" && Number.isFinite(fields[key]) ? fields[key] : undefined)
  const task = TASK_TYPES.find((item) => item === fields.task_type)
  const size = CONTEXT_SIZES.find((item) => item === fields.context_size)
  const complexity = number("complexity")
  const reasoning = number("reasoning")
  const tool_intensity = number("tool_intensity")
  const latency_sensitivity = number("latency_sensitivity")
  const ambiguity = number("ambiguity")
  const confidence = number("confidence")
  if (
    !task ||
    !size ||
    complexity === undefined ||
    reasoning === undefined ||
    tool_intensity === undefined ||
    latency_sensitivity === undefined ||
    ambiguity === undefined ||
    confidence === undefined
  )
    return undefined
  return { task_type: task, complexity, reasoning, tool_intensity, latency_sensitivity, ambiguity, context_size: size, confidence }
}

// Variant names by decreasing effort, as models.dev providers spell them.
const EFFORT_HIGH = ["high"]
const EFFORT_MAX = ["xhigh", "max", "high"]
const EFFORT_LOW = ["low", "minimal"]

// The reasoning effort variant of the chosen model, from the signals. It only changes when the model changed or
// the prompt cache is cold: a new thinking setting invalidates the cached messages. `previous` is the variant
// of the session's last routed message (undefined when there is none). OPENCODE_FORK_ROUTE_EFFORT=0 turns it off.
export function effort(
  i: {
    signals?: Signals
    tier: Tier
    available: readonly string[]
    previous?: { variant?: string }
    switched: boolean
    cold: boolean
  },
  env: Env = process.env,
) {
  if (!ForkFlags.on("ROUTE_EFFORT", env)) return undefined
  const keep = i.previous && !i.switched && !i.cold
  if (keep) return i.previous?.variant && i.available.includes(i.previous.variant) ? i.previous.variant : undefined
  const signals = i.signals
  if (!signals || signals.confidence < DEFAULTS.min_confidence || i.available.length === 0) return undefined
  const wanted =
    signals.reasoning >= 0.99 && i.tier === "frontier"
      ? EFFORT_MAX
      : signals.reasoning >= 0.67
        ? EFFORT_HIGH
        : signals.reasoning <= 0.1 && QUICK_TASKS.includes(signals.task_type)
          ? EFFORT_LOW
          : []
  return wanted.find((name) => i.available.includes(name))
}

const QUICK_TASKS: readonly TaskType[] = ["question", "repo_search", "small_edit"]

export const PLAN_NUDGE =
  "This request looks ambiguous or underspecified. Before changing anything, consider calling plan_enter to agree on a plan with the user."

// A build agent on an ambiguous request is reminded that plan mode exists. The caller supplies whether
// `plan_enter` is registered; OPENCODE_FORK_ROUTE_PLAN=0 turns it off and OPENCODE_FORK_ROUTE_PLAN_AT sets the
// ambiguity threshold (default 0.7).
export function planNudge(
  i: { signals?: Signals; agent: string; root: boolean; available: boolean },
  env: Env = process.env,
) {
  if (!ForkFlags.on("ROUTE_PLAN", env)) return false
  const at = Number(env.OPENCODE_FORK_ROUTE_PLAN_AT)
  const threshold = Number.isFinite(at) && at > 0 && at <= 1 ? at : 0.7
  const signals = i.signals
  if (!signals || signals.confidence < DEFAULTS.min_confidence) return false
  return signals.ambiguity >= threshold && i.agent === "build" && i.root && i.available
}

const STRUGGLE_WINDOW = 6
const STRUGGLE_ERRORS = 3

// Tool calls of the turn so far, oldest first: three failures among the last six mean the model is struggling.
export function struggling(tools: readonly { status: string }[], env: Env = process.env) {
  if (!ForkFlags.on("ROUTE_ESCALATE", env)) return false
  return tools.slice(-STRUGGLE_WINDOW).filter((tool) => tool.status === "error").length >= STRUGGLE_ERRORS
}

// The next tier up; undefined at the top.
export function above(tier: Tier) {
  return TIERS[rank(tier) + 1]
}

// ---------------------------------------------------------------- catalog

// USD per million tokens (models.dev).
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Model = {
  // "provider/model"
  id: string
  provider: string
  model: string
  context: number
  tools: boolean
  price: Price
}

export type Catalog = {
  models: Record<string, Model>
  tiers: Record<Tier, string[]>
}

export type SessionView = {
  tier: Tier
  // Model ID ("provider/model") and provider of the last routed turn.
  model: string
  provider: string
  // Tiers actually used by the last routed turns, oldest first.
  history: Tier[]
}

export type Candidate = { model: string; tier: Tier }

export type Decision = {
  tier: Tier
  score?: number
  // Ordered: same tier first, then higher tiers, degraded models last.
  candidates: Candidate[]
  reason: string
}

export type DecideInput = {
  mode: Mode
  // Undefined inside a tool loop (classification skipped) or when the classifier failed.
  signals?: Signals
  continuation?: boolean
  session?: SessionView
  tokens: number
  needsTools: boolean
  minTier?: Tier
  // Model or provider IDs in cooldown (or over quota): their models are tried last.
  degraded: ReadonlySet<string>
}

export function decide(i: DecideInput, catalog: Catalog, cfg: Config = DEFAULTS): Decision {
  const base =
    i.mode.kind === "tier"
      ? { tier: i.mode.tier, reason: `forced tier ${i.mode.tier}`, score: undefined }
      : autoTier(i, cfg)
  const floored = i.minTier !== undefined && rank(base.tier) < rank(i.minTier)
  const tier = floored && i.minTier ? i.minTier : base.tier
  const reason = floored ? `${base.reason}; raised to floor ${tier}` : base.reason
  return { tier, score: base.score, candidates: candidates(tier, i, catalog), reason }
}

function autoTier(i: DecideInput, cfg: Config): { tier: Tier; reason: string; score: number | undefined } {
  const session = i.session
  if (i.continuation && session) return { tier: session.tier, reason: "tool-loop continuation: keep tier", score: undefined }
  const signals = i.signals
  if (!signals || signals.confidence < cfg.min_confidence) {
    const why = signals ? "low confidence" : "no signals"
    if (session) return { tier: session.tier, reason: `${why}: hold ${session.tier}`, score: undefined }
    return { tier: "standard" as Tier, reason: `${why}: default standard`, score: undefined }
  }
  const value = score(signals)
  const target = tierOfScore(value, cfg)
  const fixed = value.toFixed(2)
  if (!session) return { tier: target, reason: `new session, score ${fixed}`, score: value }
  if (target === session.tier) return { tier: session.tier, reason: `score ${fixed} within ${session.tier}`, score: value }
  const flapping = session.history.includes(target)
  const margin = flapping ? cfg.switch_threshold : cfg.stickiness
  const dist = distanceFromBand(value, session.tier, cfg)
  const detail = `score ${fixed} is ${dist.toFixed(2)} outside ${session.tier} (margin ${margin.toFixed(2)}`
  if (dist >= margin) return { tier: target, reason: `${detail}): switch`, score: value }
  return { tier: session.tier, reason: `${detail}${flapping ? ", anti-flap" : ""}): stay`, score: value }
}

export function compatible(m: Model, tokens: number, needsTools: boolean) {
  return m.context >= tokens + OUTPUT_RESERVE_TOKENS && (!needsTools || m.tools)
}

function candidates(start: Tier, i: DecideInput, catalog: Catalog): Candidate[] {
  const seen = new Set<string>()
  const healthy: Candidate[] = []
  const degraded: Candidate[] = []
  TIERS.filter((tier) => rank(tier) >= rank(start)).forEach((tier) => {
    const models = (catalog.tiers[tier] ?? [])
      .flatMap((id) => (catalog.models[id] ? [catalog.models[id]] : []))
      .filter((m) => compatible(m, i.tokens, i.needsTools))
    const session = i.session
    // Stickiness: within the start tier the current model, then the current provider, wins.
    const sorted =
      tier === start && session
        ? models.toSorted(
            (a, b) =>
              (a.id === session.model ? 0 : a.provider === session.provider ? 1 : 2) -
              (b.id === session.model ? 0 : b.provider === session.provider ? 1 : 2),
          )
        : models
    sorted.forEach((m) => {
      if (seen.has(m.id)) return
      seen.add(m.id)
      const item = { model: m.id, tier }
      if (i.degraded.has(m.id) || i.degraded.has(m.provider)) degraded.push(item)
      else healthy.push(item)
    })
  })
  return [...healthy, ...degraded]
}

// ---------------------------------------------------------------- cache-aware switch

export type ChooseInput = DecideInput & {
  // Tokens currently in the conversation (what a model switch must write to the new cache).
  context: number
  // Estimated remaining provider turns of the session, and typical output tokens per turn.
  remaining: number
  output: number
  // The prompt cache has already expired: a switch rewrites nothing that would not be rewritten anyway.
  cold: boolean
  // Context tokens still cached per model ("provider/model") from its own earlier turns in this session:
  // switching back to such a model only rewrites what was added since.
  warm?: Record<string, number>
}

export type Choice = Decision & {
  // The model to run and the tier it stands for (the session tier when a downgrade is declined).
  model: string
  switched: boolean
}

// Cost of one cached turn: the context read from cache plus the output.
function turnCost(price: Price, context: number, output: number) {
  return (context * price.cacheRead + output * price.output) / 1_000_000
}

export function writeCost(price: Price, context: number) {
  return (context * (price.cacheWrite || price.input)) / 1_000_000
}

export type Pays = { pays: boolean; saving: number; rewrite: number }

// A downgrade pays when the saving over the remaining turns exceeds the cache rewrite.
// With a cold cache the old model would rewrite too, so that cost is not a loss.
export function downgradePays(i: {
  from: Price
  to: Price
  context: number
  remaining: number
  output: number
  cold: boolean
  cached?: number
}): Pays {
  const perTurn = turnCost(i.from, i.context, i.output) - turnCost(i.to, i.context, i.output)
  const avoided = i.cold ? writeCost(i.from, i.context) : 0
  const saving = perTurn * i.remaining + avoided
  const rewrite = writeCost(i.to, Math.max(0, i.context - (i.cached ?? 0)))
  return { pays: saving > rewrite, saving, rewrite }
}

export function choose(i: ChooseInput, catalog: Catalog, cfg: Config = DEFAULTS): Choice | undefined {
  const decision = decide(i, catalog, cfg)
  const first = decision.candidates[0]
  if (!first) return undefined
  const picked = { ...decision, model: first.model, tier: first.tier, switched: false }
  const session = i.session
  if (!session) return picked
  const switched = first.model !== session.model
  if (!switched) return { ...picked, tier: decision.tier }
  const current = catalog.models[session.model]
  const usable =
    current !== undefined &&
    compatible(current, i.tokens, i.needsTools) &&
    !i.degraded.has(current.id) &&
    !i.degraded.has(current.provider)
  const target = catalog.models[first.model]
  if (!usable || !target) return { ...picked, switched }
  // Tiers only go up freely. A downgrade, or a lateral move away from a healthy model, must pay.
  if (rank(first.tier) > rank(session.tier)) return { ...picked, switched }
  const cost = downgradePays({
    from: current.price,
    to: target.price,
    context: i.context,
    remaining: i.remaining,
    output: i.output,
    cold: i.cold,
    cached: i.warm?.[target.id],
  })
  if (cost.pays) return { ...picked, switched, reason: `${decision.reason}; switch pays (${usd(cost.saving)} > ${usd(cost.rewrite)} rewrite)` }
  return {
    ...decision,
    tier: session.tier,
    model: current.id,
    switched: false,
    reason: `${decision.reason}; kept ${current.id}: saving ${usd(cost.saving)} < ${usd(cost.rewrite)} cache rewrite`,
  }
}

function usd(value: number) {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

// ---------------------------------------------------------------- failures and health

export type Failure =
  // The request is at fault (400/413/422): no cooldown, other models may still accept it.
  | { kind: "bad_request" }
  // Network error, 5xx, auth: short exponential cooldown on the model.
  | { kind: "transient" }
  // 429/529: the model is skipped until the window reopens.
  | { kind: "rate_limited"; ms: number }
  // Quota, credits or usage cap exhausted: the whole provider is skipped.
  | { kind: "quota"; ms: number }

export const RATE_LIMIT_COOLDOWN_MS = 60_000
export const QUOTA_COOLDOWN_MS = 15 * 60_000
export const TRANSIENT_COOLDOWN_MS = 30_000
export const MAX_COOLDOWN_MS = 6 * 3_600_000

const QUOTA_TEXT = [
  "insufficient_quota",
  "exceeded your current quota",
  "quota exceeded",
  "out of extra usage",
  "usage limit",
  "credit balance",
  "insufficient credits",
  "billing_hard_limit",
]

export function classify(error: { status?: number; message: string; retryAfterMs?: number }): Failure {
  const cap = (ms: number) => Math.min(ms, MAX_COOLDOWN_MS)
  const message = error.message.toLowerCase()
  const quotaText = QUOTA_TEXT.some((key) => message.includes(key))
  const quotaStatus = error.status !== undefined && [400, 402, 403, 429].includes(error.status)
  if (error.status === 402 || (quotaStatus && quotaText))
    return { kind: "quota", ms: cap(error.retryAfterMs ?? QUOTA_COOLDOWN_MS) }
  if (error.status === 429 || error.status === 529)
    return { kind: "rate_limited", ms: cap(error.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS) }
  if (error.status === 400 || error.status === 413 || error.status === 422) return { kind: "bad_request" }
  return { kind: "transient" }
}

// In-memory per-model health. Keys are model IDs, or provider IDs for account-wide limits.
export function health() {
  const cooldowns = new Map<string, number>()
  const errors = new Map<string, number>()
  return {
    // Clears the cooldown and the error streak (a first success reopens the model).
    success(model: string) {
      errors.delete(model)
      cooldowns.delete(model)
    },
    // Exponential: base, 2x, 4x ... up to 16x for consecutive failures.
    failure(model: string, base: number, now: number) {
      const count = (errors.get(model) ?? 0) + 1
      errors.set(model, count)
      cooldowns.set(model, now + base * 2 ** Math.min(count - 1, 4))
    },
    cooldown(key: string, ms: number, now: number) {
      cooldowns.set(key, now + ms)
    },
    degraded(now: number) {
      return new Set([...cooldowns].filter(([, until]) => until > now).map(([key]) => key))
    },
    // Applies a classified failure of `model` and returns the key that was put in cooldown.
    record(model: Pick<Model, "id" | "provider">, failure: Failure, now: number) {
      if (failure.kind === "bad_request") return undefined
      if (failure.kind === "transient") {
        this.failure(model.id, TRANSIENT_COOLDOWN_MS, now)
        return model.id
      }
      const key = failure.kind === "quota" ? model.provider : model.id
      this.cooldown(key, failure.ms, now)
      return key
    },
  }
}

export type Health = ReturnType<typeof health>

// ---------------------------------------------------------------- tier lists

const TIER_KEYS = new Set<string>(TIERS)

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// `OPENCODE_FORK_ROUTE_TIERS`: {"fast": ["anthropic/claude-haiku-4-5", ...], "standard": [...], ...}.
// Unknown tiers and non-string entries are ignored; undefined when nothing usable remains.
export function parseTiers(text: string | undefined): Partial<Record<Tier, string[]>> | undefined {
  if (!text) return undefined
  const value = json(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value).flatMap(([key, ids]) =>
    TIER_KEYS.has(key) && Array.isArray(ids)
      ? [[key, ids.filter((id): id is string => typeof id === "string" && id.includes("/"))] as const]
      : [],
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}

export type Known = Model & {
  reasoning: boolean
  // ISO date, used to keep recent models only.
  released: string
  // Served through a Claude subscription: preferred while its quota window has room.
  subscription: boolean
}

const MONTH_MS = 30 * 24 * 3_600_000

// Tiers from what is connected, by output price and capability: <= $6 per million output tokens
// is FAST, <= $12 STANDARD, above that REASONING (reasoning models only) and, past $30, FRONTIER.
// Only the newest tool-capable model of each family, released within 18 months of its provider's
// newest, is considered.
// A tier left empty borrows the nearest populated one (lower first), so routing never dead-ends: with
// Fable excluded, FRONTIER falls back to the reasoning tier (Opus).
// Within a tier: subscription-backed providers first, then newest, then cheaper.
// Models never routed to, matched by substring of their ID: Fable is overkill and Opus is the ceiling;
// "-fast" and "-pro" variants cost several times the same model; realtime, image and speech models
// are not coding models.
export function excluded(env: Record<string, string | undefined> = process.env) {
  return (env.OPENCODE_FORK_ROUTE_EXCLUDE ?? "fable,-fast,-pro,realtime,image,tts")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

// "claude-opus-5-5" and "claude-opus-4-5-20251101" are both "claude-opus"; "gpt-6.1-sol" is "gpt-sol".
export function family(id: string) {
  return id
    .toLowerCase()
    .replace(/[0-9]+([.-][0-9]+)*/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function deriveTiers(models: readonly Known[], exclude: readonly string[] = excluded()): Record<Tier, string[]> {
  const newest = models.reduce<Record<string, number>>((all, m) => {
    const time = Date.parse(m.released) || 0
    return { ...all, [m.provider]: Math.max(all[m.provider] ?? 0, time) }
  }, {})
  const usable = models.filter(
    (m) =>
      m.tools &&
      m.price.output > 0 &&
      (Date.parse(m.released) || 0) >= (newest[m.provider] ?? 0) - 18 * MONTH_MS &&
      !exclude.some((part) => m.id.toLowerCase().includes(part)),
  )
  // Only the newest model of each family is current: Opus 4.5 is superseded by Opus 5.5, a dated
  // snapshot by its alias.
  const latest = usable.reduce<Record<string, Known>>((all, m) => {
    const key = `${m.provider}/${family(m.id)}`
    const held = all[key]
    const newer = !held || (Date.parse(m.released) || 0) > (Date.parse(held.released) || 0)
    const alias = held && m.released === held.released && m.id.length < held.id.length
    return newer || alias ? { ...all, [key]: m } : all
  }, {})
  const pool = Object.values(latest)
  const tierOf = (m: Known): Tier => {
    const out = m.price.output
    if (out <= 6) return "fast"
    if (out <= 12) return "standard"
    if (out > 30) return "frontier"
    return m.reasoning ? "reasoning" : "standard"
  }
  // Newest first: an older model of the same tier (Opus 4.5 next to Opus 5.5) is cheaper but weaker.
  const order = (a: Known, b: Known) =>
    Number(b.subscription) - Number(a.subscription) ||
    (Date.parse(b.released) || 0) - (Date.parse(a.released) || 0) ||
    a.price.output - b.price.output ||
    a.id.localeCompare(b.id)
  const by = (tier: Tier) => pool.filter((m) => tierOf(m) === tier).toSorted(order).map((m) => m.id)
  const raw = Object.fromEntries(TIERS.map((tier) => [tier, by(tier)])) as Record<Tier, string[]>
  return Object.fromEntries(
    TIERS.map((tier) => {
      if (raw[tier].length) return [tier, raw[tier]]
      const below = TIERS.slice(0, rank(tier)).toReversed().find((t) => raw[t].length)
      const above = TIERS.slice(rank(tier) + 1).find((t) => raw[t].length)
      const from = below ?? above
      return [tier, from ? raw[from] : []]
    }),
  ) as Record<Tier, string[]>
}

// ---------------------------------------------------------------- signals (small model)

export type Summary = {
  first?: string
  messages: number
  tokens: number
  tools?: string[]
  lastAnswer?: string
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

// The small model reads the user's prompt and a short context summary and answers with JSON.
export function signalsPrompt(prompt: string, summary: Summary) {
  const lines = [
    "You are a request classifier, not an assistant. Do not answer, greet or help with the request below:",
    "classify it so it can be routed to the cheapest sufficient LLM.",
    "Answer with one JSON object and nothing else. Never name a model.",
    "",
    "Fields:",
    `- task_type: one of ${TASK_TYPES.join(", ")}`,
    "  (question: explanation, no code change; repo_search: find or read something; small_edit: typo, rename, tiny local edit;",
    "  feature: standard production code; debugging: diagnose a failure; refactor: restructure code;",
    "  architecture: system design or whole-codebase analysis; tests; docs; other)",
    "- complexity: 0 trivial, 0.33 routine, 0.66 hard, 1 very hard or massive scope",
    "- reasoning: 0 none, 0.33 some, 0.66 substantial multi-step, 1 maximal and subtle (concurrency, distributed systems)",
    "- tool_intensity: 0 no tool calls, 0.33 a few, 0.66 many, 1 dozens across many files",
    "- latency_sensitivity: 0 can wait, 0.33 normal, 0.66 wants it quick, 1 interactive",
    "- ambiguity: 0 clear .. 1 ambiguous, underspecified or open-ended",
    "- confidence: 0..1, how sure you are of all of the above",
    "A greeting, thanks or small talk is task_type other with every level at 0 and confidence 1.",
    "Use the whole 0..1 range with two decimals. Anchors for complexity and reasoning:",
    "  0.10-0.20 rename, README, one-line fix; 0.35-0.45 one function with its test, a localized bug fix;",
    "  0.45-0.55 refactor of one module with tests; 0.70-0.90 cross-module feature, concurrency, distributed",
    "  systems; 0.90-1 architecture or whole-codebase analysis.",
    "",
    '{"task_type":"...","complexity":0,"reasoning":0,"tool_intensity":0,"latency_sensitivity":0,"ambiguity":0,"confidence":0}',
    "",
    "Context:",
  ]
  if (summary.first) lines.push(`Conversation opened with: ${truncate(summary.first, 500)}`)
  lines.push(`Messages so far: ${summary.messages}. Approx context tokens: ${summary.tokens}.`)
  if (summary.tools?.length) lines.push(`Tools available: ${summary.tools.slice(0, 20).join(", ")}.`)
  if (summary.lastAnswer) lines.push(`Last assistant answer: ${truncate(summary.lastAnswer, 300)}`)
  lines.push(
    "",
    "Latest user message to classify:",
    "<request>",
    truncate(prompt, 3000),
    "</request>",
    "",
    "Reply with the JSON object only, starting with {. Even a greeting or a one-word message gets classified, not answered.",
  )
  return lines.join("\n")
}

// Undefined when the answer is not usable: the caller then keeps the current tier.
export function parseSignals(text: string, size: ContextSize): Signals | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  const value = json(text.slice(start, end + 1))
  if (typeof value !== "object" || value === null) return undefined
  const get = (key: string): unknown => Object.entries(value).find(([name]) => name === key)?.[1]
  const level = (key: string, fallback?: number) => {
    const raw = get(key)
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.min(1, Math.max(0, raw))
    return fallback
  }
  const complexity = level("complexity")
  const reasoning = level("reasoning")
  const tool_intensity = level("tool_intensity")
  const latency_sensitivity = level("latency_sensitivity")
  const confidence = level("confidence", 0.5)
  if (
    complexity === undefined ||
    reasoning === undefined ||
    tool_intensity === undefined ||
    latency_sensitivity === undefined ||
    confidence === undefined
  )
    return undefined
  const type = get("task_type")
  return {
    task_type: TASK_TYPES.find((item) => item === type) ?? "other",
    complexity,
    reasoning,
    tool_intensity,
    latency_sensitivity,
    ambiguity: level("ambiguity", 0) ?? 0,
    context_size: size,
    confidence,
  }
}

// ---------------------------------------------------------------- quota

export const DEFAULT_QUOTA_THRESHOLD = 0.9

// `OPENCODE_FORK_ROUTE_QUOTA`: share of the subscription's 5-hour window above which its models are tried last.
export function quotaThreshold(env: string | undefined) {
  const value = Number(env)
  return env && Number.isFinite(value) && value > 0 ? value : DEFAULT_QUOTA_THRESHOLD
}

export * as ForkRoute from "./route"
import { ForkFlags } from "./flags"
