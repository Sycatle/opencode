import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import { ForkRoute } from "../src/route"
import { ForkRouteLog } from "../src/route-log"

// The database opens on first use, after this: always a fresh file.
process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-route-${process.pid}-${Date.now()}.db`)

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const model = (provider: string, name: string, context: number, tools = true, price = free): ForkRoute.Model => ({
  id: `${provider}/${name}`,
  provider,
  model: name,
  context,
  tools,
  price,
})

// Same catalog as the llm-router policy tests.
const catalog: ForkRoute.Catalog = {
  models: Object.fromEntries(
    [
      model("openai", "fast", 128_000),
      model("mistral", "cheap", 32_000, false),
      model("anthropic", "sonnet", 200_000),
      model("openai", "reasoning", 200_000),
      model("anthropic", "opus", 200_000),
    ].map((m) => [m.id, m]),
  ),
  tiers: {
    fast: ["mistral/cheap", "openai/fast"],
    standard: ["anthropic/sonnet"],
    reasoning: ["openai/reasoning", "anthropic/sonnet"],
    frontier: ["anthropic/opus"],
  },
}

const signals = (
  task: ForkRoute.TaskType,
  complexity: number,
  reasoning: number,
  tool: number,
  ambiguity: number,
  size: ForkRoute.ContextSize,
): ForkRoute.Signals => ({
  task_type: task,
  complexity,
  reasoning,
  tool_intensity: tool,
  latency_sensitivity: 0.3,
  ambiguity,
  context_size: size,
  confidence: 0.9,
})
const trivial = () => signals("small_edit", 0.05, 0.05, 0.1, 0, "small")
const feature = () => signals("feature", 0.5, 0.45, 0.4, 0.1, "medium")
const hardBug = () => signals("debugging", 0.78, 0.84, 0.55, 0.3, "large")
const bigArch = () => signals("architecture", 0.95, 0.95, 0.7, 0.6, "huge")

const run = (input: Partial<ForkRoute.DecideInput> = {}) =>
  ForkRoute.decide(
    { mode: { kind: "auto" }, tokens: 1000, needsTools: true, degraded: new Set(), ...input },
    catalog,
  )
const inSession = (tier: ForkRoute.Tier, id: string, history: ForkRoute.Tier[]): ForkRoute.SessionView => ({
  tier,
  model: id,
  provider: id.split("/")[0],
  history,
})
const first = (d: ForkRoute.Decision) => d.candidates[0].model

test("a trivial prompt is FAST and skips models without tools", () => {
  const d = run({ signals: trivial() })
  expect(d.tier).toBe("fast")
  expect(first(d)).toBe("openai/fast")
})

test("a standard feature is STANDARD", () => {
  const d = run({ signals: feature() })
  expect(d.tier).toBe("standard")
  expect(first(d)).toBe("anthropic/sonnet")
})

test("a complex bug is REASONING and big architecture is FRONTIER", () => {
  expect(run({ signals: hardBug() }).tier).toBe("reasoning")
  expect(first(run({ signals: hardBug() }))).toBe("openai/reasoning")
  const d = run({ signals: bigArch() })
  expect(d.tier).toBe("frontier")
  expect(first(d)).toBe("anthropic/opus")
})

test("score weights and adjustments", () => {
  expect(ForkRoute.score(feature())).toBeCloseTo(0.4 * 0.45 + 0.3 * 0.5 + 0.15 * 0.4 + 0.15 * 0.1 - 0.03, 10)
  expect(ForkRoute.score(trivial())).toBe(0)
  expect(ForkRoute.score({ ...bigArch(), reasoning: 1, complexity: 1, tool_intensity: 1, ambiguity: 1 })).toBe(1)
  expect(ForkRoute.score({ ...trivial(), reasoning: 0, complexity: 0, tool_intensity: 0, latency_sensitivity: 1 })).toBe(0)
  expect(ForkRoute.contextSize(7_999)).toBe("small")
  expect(ForkRoute.contextSize(8_000)).toBe("medium")
  expect(ForkRoute.contextSize(40_000)).toBe("large")
  expect(ForkRoute.contextSize(120_000)).toBe("huge")
  expect(ForkRoute.tierOfScore(0.3)).toBe("standard")
  expect(ForkRoute.tierOfScore(0.8)).toBe("frontier")
})

test("an unavailable classifier defaults to STANDARD or holds the tier", () => {
  expect(run({ signals: ForkRoute.unknown("small") }).tier).toBe("standard")
  expect(run().tier).toBe("standard")
  const session = inSession("reasoning", "openai/reasoning", ["reasoning"])
  expect(run({ signals: ForkRoute.unknown("small"), session }).tier).toBe("reasoning")
  expect(run({ session }).tier).toBe("reasoning")
})

test("degraded models and providers are tried last", () => {
  const d = run({ signals: trivial(), needsTools: false, degraded: new Set(["openai/fast"]) })
  expect(first(d)).toBe("mistral/cheap")
  expect(d.candidates.at(-1)?.model).toBe("openai/fast")
  // A provider-wide cooldown covers all of its models.
  const all = run({ signals: feature(), degraded: new Set(["anthropic"]) })
  expect(first(all)).toBe("openai/reasoning")
  expect(all.candidates.at(-1)?.model).toBe("anthropic/opus")
})

test("the fallback chain escalates through higher tiers without duplicates", () => {
  const d = run({ signals: trivial() })
  expect(d.candidates.map((c) => c.model)).toEqual([
    "openai/fast",
    "anthropic/sonnet",
    "openai/reasoning",
    "anthropic/opus",
  ])
  expect(d.candidates[1].tier).toBe("standard")
})

test("session stickiness keeps the tier for a small score change", () => {
  const d = run({ signals: feature(), session: inSession("fast", "openai/fast", ["fast"]) })
  expect(d.tier).toBe("fast")
})

test("a large gap switches tier", () => {
  const d = run({ signals: hardBug(), session: inSession("fast", "openai/fast", ["fast"]) })
  expect(d.tier).toBe("reasoning")
})

test("the switch threshold blocks flapping", () => {
  const flat = { ...trivial(), complexity: 0, reasoning: 0, ambiguity: 0, tool_intensity: 0, task_type: "other" as const, latency_sensitivity: 0 }
  const standard = (history: ForkRoute.Tier[]) => inSession("standard", "anthropic/sonnet", history)
  // score 0 is 0.30 outside the STANDARD band: switch
  expect(run({ signals: flat, session: standard(["standard"]) }).tier).toBe("fast")
  // score 0.13 is 0.17 outside: passes stickiness (0.15)
  const near = { ...flat, reasoning: 0.325 }
  expect(run({ signals: near, session: standard(["standard"]) }).tier).toBe("fast")
  // FAST was used recently: needs 0.20, only 0.17 -> stay
  const d = run({ signals: near, session: standard(["fast", "standard"]) })
  expect(d.tier).toBe("standard")
  expect(d.reason).toContain("anti-flap")
})

test("a tool-loop continuation keeps the tier", () => {
  const d = run({ continuation: true, session: inSession("reasoning", "openai/reasoning", ["reasoning"]) })
  expect(d.tier).toBe("reasoning")
  expect(first(d)).toBe("openai/reasoning")
})

test("the current model, then the current provider, wins inside the tier", () => {
  const d = run({ signals: hardBug(), session: inSession("reasoning", "anthropic/sonnet", ["reasoning"]) })
  expect(d.tier).toBe("reasoning")
  expect(first(d)).toBe("anthropic/sonnet")
})

test("a forced tier and a tier floor", () => {
  expect(run({ mode: { kind: "tier", tier: "reasoning" }, signals: trivial() }).tier).toBe("reasoning")
  expect(run({ minTier: "reasoning", signals: trivial() }).tier).toBe("reasoning")
})

test("a context too large for small models skips them", () => {
  expect(first(run({ signals: trivial(), needsTools: false, tokens: 100_000 }))).toBe("openai/fast")
  expect(first(run({ signals: trivial(), needsTools: false, tokens: 150_000 }))).toBe("anthropic/sonnet")
  expect(run({ signals: trivial(), needsTools: false, tokens: 500_000 }).candidates).toEqual([])
})

test("mode parsing", () => {
  expect(ForkRoute.parseMode("auto")).toEqual({ kind: "auto" })
  expect(ForkRoute.parseMode("auto-frontier")).toEqual({ kind: "tier", tier: "frontier" })
  expect(ForkRoute.parseMode("Fast")).toEqual({ kind: "tier", tier: "fast" })
  expect(ForkRoute.parseMode("opus")).toBeUndefined()
})

// ---------------------------------------------------------------- failure classification

test("limits are classified whatever the provider's wording", () => {
  const err = (status: number | undefined, message: string, retryAfterMs?: number) =>
    ForkRoute.classify({ status, message, retryAfterMs })
  expect(err(429, "Rate limit reached")).toEqual({ kind: "rate_limited", ms: 60_000 })
  expect(err(529, "overloaded")).toEqual({ kind: "rate_limited", ms: 60_000 })
  expect(err(429, '{"code":"insufficient_quota"}').kind).toBe("quota")
  expect(err(400, "You're out of extra usage").kind).toBe("quota")
  expect(err(402, "payment required")).toEqual({ kind: "quota", ms: 15 * 60_000 })
  expect(err(400, "invalid tool schema").kind).toBe("bad_request")
  expect(err(503, "down").kind).toBe("transient")
  expect(err(undefined, "timeout").kind).toBe("transient")
})

test("Retry-After is honoured and capped", () => {
  expect(ForkRoute.classify({ status: 429, message: "slow down", retryAfterMs: 7_000 })).toEqual({
    kind: "rate_limited",
    ms: 7_000,
  })
  expect(ForkRoute.classify({ status: 429, message: "slow down", retryAfterMs: 999_999_000 })).toEqual({
    kind: "rate_limited",
    ms: ForkRoute.MAX_COOLDOWN_MS,
  })
})

test("a cooldown marks models degraded and a success clears it", () => {
  const h = ForkRoute.health()
  const m = catalog.models["anthropic/sonnet"]
  h.record(m, { kind: "transient" }, 0)
  expect(h.degraded(1).has("anthropic/sonnet")).toBe(true)
  expect(h.degraded(ForkRoute.TRANSIENT_COOLDOWN_MS + 1).size).toBe(0)
  // consecutive failures back off exponentially
  h.record(m, { kind: "transient" }, 0)
  expect(h.degraded(ForkRoute.TRANSIENT_COOLDOWN_MS + 1).has("anthropic/sonnet")).toBe(true)
  expect(h.record(m, { kind: "bad_request" }, 0)).toBeUndefined()
  expect(h.record(m, { kind: "quota", ms: 1000 }, 0)).toBe("anthropic")
  expect(h.record(m, { kind: "rate_limited", ms: 1000 }, 0)).toBe("anthropic/sonnet")
  h.success("anthropic/sonnet")
  expect(h.degraded(1).has("anthropic/sonnet")).toBe(false)
  expect(h.degraded(1).has("anthropic")).toBe(true)
})

// ---------------------------------------------------------------- cache-aware switch

const price = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
})
const haiku = model("anthropic", "haiku", 200_000, true, price(1, 5, 0.1, 1.25))
const sonnet = model("anthropic", "sonnet", 200_000, true, price(3, 15, 0.3, 3.75))
const opus = model("anthropic", "opus", 200_000, true, price(5, 25, 0.5, 6.25))
const priced: ForkRoute.Catalog = {
  models: Object.fromEntries([haiku, sonnet, opus].map((m) => [m.id, m])),
  tiers: { fast: [haiku.id], standard: [sonnet.id], reasoning: [opus.id], frontier: [opus.id] },
}
const choose = (input: Partial<ForkRoute.ChooseInput>) =>
  ForkRoute.choose(
    {
      mode: { kind: "auto" },
      tokens: 100_000,
      context: 100_000,
      needsTools: true,
      degraded: new Set(),
      remaining: 6,
      output: 1500,
      cold: false,
      ...input,
    },
    priced,
  )
const easy = () => ({ ...trivial(), complexity: 0, reasoning: 0, tool_intensity: 0, latency_sensitivity: 0 })

test("a new session starts from the target tier", () => {
  const c = choose({ signals: easy() })
  expect(c?.model).toBe(haiku.id)
  expect(c?.tier).toBe("fast")
})

test("a tier upgrade switches without a cost check", () => {
  const c = choose({ signals: hardBug(), session: inSession("fast", haiku.id, ["fast"]) })
  expect(c?.model).toBe(opus.id)
  expect(c?.switched).toBe(true)
})

test("a downgrade is declined when the saving does not cover the cache rewrite", () => {
  // 100k tokens: rewriting on haiku costs $0.125; 6 turns save (100k*0.2 + 1500*10)/1M*6 = $0.21... with a short horizon it does not pay
  const c = choose({ signals: easy(), session: inSession("standard", sonnet.id, ["standard"]), remaining: 1 })
  expect(c?.model).toBe(sonnet.id)
  expect(c?.tier).toBe("standard")
  expect(c?.switched).toBe(false)
  expect(c?.reason).toContain("cache rewrite")
})

test("a downgrade is taken when the remaining turns repay the rewrite", () => {
  const c = choose({ signals: easy(), session: inSession("standard", sonnet.id, ["standard"]), remaining: 20 })
  expect(c?.model).toBe(haiku.id)
  expect(c?.tier).toBe("fast")
  expect(c?.switched).toBe(true)
  expect(c?.reason).toContain("switch pays")
})

test("a cold cache makes a downgrade free", () => {
  const session = inSession("standard", sonnet.id, ["standard"])
  expect(choose({ signals: easy(), session, remaining: 1 })?.switched).toBe(false)
  expect(choose({ signals: easy(), session, remaining: 1, cold: true })?.model).toBe(haiku.id)
})

test("an unhealthy current model is replaced whatever it costs", () => {
  const c = choose({
    signals: feature(),
    session: inSession("standard", sonnet.id, ["standard"]),
    degraded: new Set([sonnet.id]),
    remaining: 1,
  })
  expect(c?.model).not.toBe(sonnet.id)
})

test("downgradePays compares saving and rewrite", () => {
  const r = ForkRoute.downgradePays({ from: sonnet.price, to: haiku.price, context: 100_000, remaining: 10, output: 1000, cold: false })
  expect(r.rewrite).toBeCloseTo(0.125, 6)
  expect(r.saving).toBeCloseTo(((100_000 * 0.2 + 1000 * 10) / 1_000_000) * 10, 6)
  expect(r.pays).toBe(true)
})

test("switching back to a model with a warm cache only rewrites what was added since", () => {
  const input = { from: sonnet.price, to: haiku.price, context: 100_000, remaining: 10, output: 1000, cold: false }
  expect(ForkRoute.downgradePays({ ...input, cached: 90_000 }).rewrite).toBeCloseTo(
    ForkRoute.downgradePays({ ...input, context: 10_000 }).rewrite,
    6,
  )
  expect(ForkRoute.downgradePays({ ...input, cached: 200_000 }).rewrite).toBe(0)
})

// ---------------------------------------------------------------- tiers, signals, quota

const known = (
  provider: string,
  name: string,
  output: number,
  extra: Partial<ForkRoute.Known> = {},
): ForkRoute.Known => ({
  ...model(provider, name, 200_000, true, price(output / 5, output, output / 50, output / 4)),
  reasoning: false,
  released: "2026-01-01",
  subscription: false,
  ...extra,
})

test("tiers are derived from price and capability, and never left empty", () => {
  const tiers = ForkRoute.deriveTiers([
    known("anthropic", "haiku", 5),
    known("anthropic", "sonnet", 15),
    known("anthropic", "opus", 25, { reasoning: true }),
    known("anthropic", "old", 5, { released: "2023-01-01" }),
    known("openai", "mini", 2),
  ])
  expect(tiers.fast).toEqual(["openai/mini", "anthropic/haiku"])
  expect(tiers.standard).toEqual(["anthropic/sonnet"])
  expect(tiers.reasoning).toEqual(["anthropic/opus"])
  expect(tiers.frontier).toEqual(["anthropic/opus"])
})

test("only the newest model of each family is routed to (Anthropic catalog of October 2026)", () => {
  const r = (released: string) => ({ released, reasoning: true })
  const tiers = ForkRoute.deriveTiers([
    known("anthropic", "claude-haiku-4-5", 5, { released: "2025-10-15" }),
    known("anthropic", "claude-haiku-4-5-20251001", 5, { released: "2025-10-15" }),
    known("anthropic", "claude-sonnet-4-5", 15, r("2025-09-29")),
    known("anthropic", "claude-sonnet-5-5", 10, r("2026-09-28")),
    known("anthropic", "claude-opus-4-5", 25, r("2025-11-24")),
    known("anthropic", "claude-opus-5-5", 20, r("2026-09-22")),
    known("anthropic", "claude-fable-5-1", 50, r("2026-09-01")),
  ])
  expect(tiers).toEqual({
    fast: ["anthropic/claude-haiku-4-5"],
    standard: ["anthropic/claude-sonnet-5-5"],
    reasoning: ["anthropic/claude-opus-5-5"],
    frontier: ["anthropic/claude-opus-5-5"],
  })
  expect(ForkRoute.family("gpt-6.1-sol")).toBe(ForkRoute.family("gpt-5.6-sol"))
})

test("Fable is never routed to: frontier tops out at Opus", () => {
  const tiers = ForkRoute.deriveTiers([
    known("anthropic", "claude-haiku", 5),
    known("anthropic", "claude-opus", 25, { reasoning: true }),
    known("anthropic", "claude-fable", 75, { reasoning: true }),
  ])
  expect(tiers.frontier).toEqual(["anthropic/claude-opus"])
  expect(Object.values(tiers).flat()).not.toContain("anthropic/claude-fable")
})

test("a greeting is framed as a request to classify, not to answer", () => {
  const text = ForkRoute.signalsPrompt("bonjour", { messages: 1, tokens: 12000 })
  expect(text).toContain("<request>\nbonjour\n</request>")
  expect(text).toContain("Do not answer")
})

test("subscription-backed providers come first inside a tier", () => {
  const tiers = ForkRoute.deriveTiers([known("openai", "mini", 2), known("anthropic", "haiku", 5, { subscription: true })])
  expect(tiers.fast).toEqual(["anthropic/haiku", "openai/mini"])
})

test("tier lists parse from JSON and ignore junk", () => {
  expect(ForkRoute.parseTiers(undefined)).toBeUndefined()
  expect(ForkRoute.parseTiers("not json")).toBeUndefined()
  expect(ForkRoute.parseTiers('{"fast":["a/b", 3, "nope"],"weird":["a/b"]}')).toEqual({ fast: ["a/b"] })
})

test("the small model's JSON answer becomes signals", () => {
  const answer =
    'Sure.\n{"task_type":"debugging","complexity":0.8,"reasoning":1.4,"tool_intensity":0.5,"latency_sensitivity":0.1,"ambiguity":0.2,"confidence":0.85}'
  expect(ForkRoute.parseSignals(answer, "large")).toEqual({
    task_type: "debugging",
    complexity: 0.8,
    reasoning: 1,
    tool_intensity: 0.5,
    latency_sensitivity: 0.1,
    ambiguity: 0.2,
    context_size: "large",
    confidence: 0.85,
  })
  expect(ForkRoute.parseSignals("no json", "small")).toBeUndefined()
  expect(ForkRoute.parseSignals('{"task_type":"feature"}', "small")).toBeUndefined()
  expect(ForkRoute.signalsPrompt("fix the typo", { messages: 3, tokens: 900, tools: ["read"], first: "hello" })).toContain(
    "<request>\nfix the typo\n</request>",
  )
})

test("the quota threshold defaults to 0.9", () => {
  expect(ForkRoute.quotaThreshold(undefined)).toBe(0.9)
  expect(ForkRoute.quotaThreshold("0.75")).toBe(0.75)
  expect(ForkRoute.quotaThreshold("abc")).toBe(0.9)
})

test("the journal keeps decisions and fallbacks per session", () => {
  const entry = (kind: "decision" | "fallback", model_id: string): Parameters<typeof ForkRouteLog.record>[0] => ({
    time: Date.now(),
    session_id: "ses_route",
    message_id: "msg_1",
    kind,
    mode: "auto",
    tier: "standard",
    provider_id: "anthropic",
    model_id,
    reason: "test",
    signals: feature(),
  })
  ForkRouteLog.record(entry("decision", "sonnet"))
  ForkRouteLog.record(entry("fallback", "haiku"))
  expect(ForkRouteLog.decisions("ses_route", 5).map((r) => r.model_id)).toEqual(["sonnet"])
  expect(ForkRouteLog.forMessage("ses_route", "msg_1")?.model_id).toBe("haiku")
  expect(ForkRouteLog.latest("ses_route")?.kind).toBe("fallback")
  expect(ForkRouteLog.summary().find((r) => r.model === "anthropic/haiku")?.fallbacks).toBe(1)
  expect(JSON.parse(ForkRouteLog.recent(1)[0].signals ?? "{}").task_type).toBe("feature")
})

const seen: ForkRoute.Signals = { ...ForkRoute.unknown("small"), task_type: "feature", reasoning: 0.7, confidence: 0.8, source: "jev" }

test("a short follow-up reuses confident, recent signals; long, stale, unsure or first messages are classified", () => {
  const previous = { signals: seen, time: 1_000_000 }
  const at = (prompt: string, over: Partial<{ signals: ForkRoute.Signals; time: number }> = {}, now = 1_060_000) =>
    ForkRoute.shouldReclassify({ prompt, previous: { ...previous, ...over }, now }, {})
  expect(at("ok, go on")).toBe(false)
  expect(at("run the tests and fix whatever fails in the billing module first")).toBe(false)
  expect(at("Please refactor the whole billing module so that invoices are computed lazily and cached per customer")).toBe(true)
  expect(at("ok", {}, 1_000_000 + 31 * 60_000)).toBe(true)
  expect(at("ok", { signals: { ...seen, confidence: 0.5 } })).toBe(true)
  expect(ForkRoute.shouldReclassify({ prompt: "ok", now: 5 }, {})).toBe(true)
  expect(ForkRoute.shouldReclassify({ prompt: "ok", previous, now: 1_060_000 }, { OPENCODE_FORK_ROUTE_RECLASSIFY: "0" })).toBe(true)
})

test("effort follows the reasoning signal, only moves with the model or a cold cache, and needs the variant", () => {
  const input = { tier: "reasoning" as const, available: ["low", "high", "max"], switched: false, cold: false }
  const hard = { ...seen, reasoning: 0.8 }
  expect(ForkRoute.effort({ ...input, signals: hard }, {})).toBe("high")
  expect(ForkRoute.effort({ ...input, signals: hard, tier: "frontier" }, {})).toBe("high")
  expect(ForkRoute.effort({ ...input, signals: { ...hard, reasoning: 1 }, tier: "frontier" }, {})).toBe("max")
  expect(ForkRoute.effort({ ...input, signals: { ...seen, reasoning: 0.05, task_type: "question" } }, {})).toBe("low")
  expect(ForkRoute.effort({ ...input, signals: { ...seen, reasoning: 0.05, task_type: "feature" } }, {})).toBeUndefined()
  expect(ForkRoute.effort({ ...input, signals: hard, available: [] }, {})).toBeUndefined()
  expect(ForkRoute.effort({ ...input, signals: { ...hard, confidence: 0.2 } }, {})).toBeUndefined()
  // Same model, warm cache: the previous variant is kept, whatever the new signals say.
  expect(ForkRoute.effort({ ...input, signals: { ...hard, reasoning: 0.05 }, previous: { variant: "high" } }, {})).toBe("high")
  expect(ForkRoute.effort({ ...input, signals: hard, previous: { variant: undefined } }, {})).toBeUndefined()
  expect(ForkRoute.effort({ ...input, signals: hard, previous: { variant: "xhigh" } }, {})).toBeUndefined()
  expect(ForkRoute.effort({ ...input, signals: hard, previous: { variant: "low" }, switched: true }, {})).toBe("high")
  expect(ForkRoute.effort({ ...input, signals: hard, previous: { variant: "low" }, cold: true }, {})).toBe("high")
  expect(ForkRoute.effort({ ...input, signals: hard }, { OPENCODE_FORK_ROUTE_EFFORT: "0" })).toBeUndefined()
})

test("the plan nudge needs an ambiguous, confident request to a root build agent with plan mode available", () => {
  const input = { signals: { ...seen, ambiguity: 0.8 }, agent: "build", root: true, available: true }
  expect(ForkRoute.planNudge(input, {})).toBe(true)
  expect(ForkRoute.planNudge({ ...input, signals: { ...seen, ambiguity: 0.6 } }, {})).toBe(false)
  expect(ForkRoute.planNudge({ ...input, signals: { ...input.signals, confidence: 0.2 } }, {})).toBe(false)
  expect(ForkRoute.planNudge({ ...input, agent: "plan" }, {})).toBe(false)
  expect(ForkRoute.planNudge({ ...input, root: false }, {})).toBe(false)
  expect(ForkRoute.planNudge({ ...input, available: false }, {})).toBe(false)
  expect(ForkRoute.planNudge({ ...input, signals: undefined }, {})).toBe(false)
  expect(ForkRoute.planNudge({ ...input, signals: { ...seen, ambiguity: 0.6 } }, { OPENCODE_FORK_ROUTE_PLAN_AT: "0.5" })).toBe(true)
  expect(ForkRoute.planNudge(input, { OPENCODE_FORK_ROUTE_PLAN: "0" })).toBe(false)
})

test("three failed tool calls among the last six mean struggling, and the next tier is above", () => {
  const run = (...status: string[]) => ForkRoute.struggling(status.map((item) => ({ status: item })), {})
  expect(run("error", "completed", "error", "completed", "error")).toBe(true)
  expect(run("error", "error", "completed")).toBe(false)
  expect(run("error", "error", "error", "completed", "completed", "completed", "completed")).toBe(false)
  expect(ForkRoute.struggling([{ status: "error" }, { status: "error" }, { status: "error" }], { OPENCODE_FORK_ROUTE_ESCALATE: "0" })).toBe(false)
  expect(ForkRoute.above("fast")).toBe("standard")
  expect(ForkRoute.above("frontier")).toBeUndefined()
})
