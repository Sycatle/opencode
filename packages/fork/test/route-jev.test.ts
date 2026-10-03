import { expect, test } from "bun:test"
import { ForkRouteJev } from "../src/route-jev"

// Same fixed response as the llm-router tests (classifier.rs).
const canned = {
  model: "jev-1",
  answers: {
    task_type: { type: "choice", choice: "debugging", confidence: 0.9, probabilities: {} },
    complexity: { type: "score", score: 2.0, confidence: 0.8, probabilities: {} },
    reasoning: { type: "score", score: 3.0, confidence: 1.0, probabilities: {} },
    tool_intensity: { type: "score", score: 1.0, confidence: 0.9, probabilities: {} },
    latency_sensitivity: { type: "score", score: 0.0, confidence: 0.9, probabilities: {} },
    ambiguity: { type: "noul", noul: 0.25 },
  },
}

const env = { TYPESAFE_API_KEY: "k", OPENCODE_FORK_JEV_URL: "http://jev.test/" }
const input = { prompt: "find the deadlock", summary: { messages: 1, tokens: 50_000 }, size: "large" as const }

function fake(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit | undefined }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { seen, fetcher }
}

test("a Jev response becomes signals", () => {
  const signals = ForkRouteJev.parse(canned, "large")
  expect(signals?.task_type).toBe("debugging")
  expect(signals?.complexity).toBeCloseTo(2 / 3, 9)
  expect(signals?.reasoning).toBe(1)
  expect(signals?.tool_intensity).toBeCloseTo(1 / 3, 9)
  expect(signals?.latency_sensitivity).toBe(0)
  expect(signals?.ambiguity).toBe(0.25)
  expect(signals?.context_size).toBe("large")
  expect(signals?.confidence).toBeCloseTo(0.9, 9)
})

test("unknown choices become other, a missing confidence is 0.5, out-of-range values are clamped", () => {
  const body = {
    answers: {
      task_type: { choice: "poetry" },
      complexity: { score: 7 },
      reasoning: { score: -1 },
      tool_intensity: { score: 3 },
      latency_sensitivity: { score: 1.5 },
      ambiguity: { noul: 4 },
    },
  }
  expect(ForkRouteJev.parse(body, "small")).toEqual({
    task_type: "other",
    complexity: 1,
    reasoning: 0,
    tool_intensity: 1,
    latency_sensitivity: 0.5,
    ambiguity: 1,
    context_size: "small",
    confidence: 0.5,
  })
})

test("an invalid response is undefined", () => {
  expect(ForkRouteJev.parse(undefined, "small")).toBeUndefined()
  expect(ForkRouteJev.parse({}, "small")).toBeUndefined()
  expect(ForkRouteJev.parse({ answers: [] }, "small")).toBeUndefined()
  expect(ForkRouteJev.parse({ answers: { ...canned.answers, complexity: { type: "score" } } }, "small")).toBeUndefined()
  expect(ForkRouteJev.parse({ answers: { ...canned.answers, ambiguity: undefined } }, "small")).toBeUndefined()
  const { reasoning: _, ...partial } = canned.answers
  expect(ForkRouteJev.parse({ answers: partial }, "small")).toBeUndefined()
})

test("the request carries the state and the same questions as llm-router", () => {
  const body = ForkRouteJev.request(
    { prompt: "x".repeat(4000), summary: { first: "hello", messages: 3, tokens: 900, tools: ["read", "edit"] } },
  )
  expect(body.state).toStartWith("Coding-agent request to route to the cheapest sufficient LLM.\nConversation opened with: hello\n")
  expect(body.state).toContain("Messages so far: 3. Approx context tokens: 900. Tools available: read, edit.\n")
  expect(body.state).toEndWith(`Latest user message:\n${"x".repeat(3000)}...`)
  expect(Object.keys(body.questions)).toEqual([
    "task_type",
    "complexity",
    "reasoning",
    "tool_intensity",
    "latency_sensitivity",
    "ambiguity",
  ])
  expect(body.questions.task_type.type).toBe("choice")
  expect(Object.keys(body.questions.task_type.criteria)).toHaveLength(10)
  expect(body.questions.reasoning.type).toBe("score")
  expect(body.questions.reasoning.criteria).toHaveLength(4)
  expect(body.questions.ambiguity.type).toBe("noul")
  expect(ForkRouteJev.request({ prompt: "p", summary: { messages: 0, tokens: 0 } }).state).toContain("Tools available: none.")
})

test("a call posts to /v1/systemone with a bearer token and returns the signals", async () => {
  const { seen, fetcher } = fake(200, canned)
  const result = await ForkRouteJev.call(input, env, fetcher)
  expect(result.signals?.task_type).toBe("debugging")
  expect(result.signals?.context_size).toBe("large")
  expect(seen[0]?.url).toBe("http://jev.test/v1/systemone")
  expect(seen[0]?.init?.method).toBe("POST")
  expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer k")
  expect(JSON.parse(String(seen[0]?.init?.body)).questions.task_type.criteria).toBeObject()
  expect(JSON.parse(String(seen[0]?.init?.body)).model).toBe("jev-latest")
})

test("HTTP errors, unusable bodies, network failures and timeouts are errors", async () => {
  expect((await ForkRouteJev.call(input, env, fake(500, {}).fetcher)).error).toBe("Jev returned HTTP 500")
  expect((await ForkRouteJev.call(input, env, fake(401, {}).fetcher)).error).toBe("Jev returned HTTP 401")
  expect((await ForkRouteJev.call(input, env, fake(200, { answers: {} }).fetcher)).error).toBe("Jev response unusable")
  const down = (async () => {
    throw new Error("connection refused")
  }) as unknown as typeof fetch
  expect((await ForkRouteJev.call(input, env, down)).error).toContain("connection refused")
  const hang = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch
  const slow = await ForkRouteJev.call(input, { ...env, OPENCODE_FORK_JEV_TIMEOUT_MS: "20" }, hang)
  expect(slow.signals).toBeUndefined()
  expect(slow.error).toStartWith("Jev request failed")
})

test("Jev is enabled by a key and switched off by OPENCODE_FORK_ROUTE_JEV=0", () => {
  expect(ForkRouteJev.enabled({})).toBe(false)
  expect(ForkRouteJev.enabled({ TYPESAFE_API_KEY: "" })).toBe(false)
  expect(ForkRouteJev.enabled({ TYPESAFE_API_KEY: "k" })).toBe(true)
  expect(ForkRouteJev.enabled({ TYPESAFE_API_KEY: "k", OPENCODE_FORK_ROUTE_JEV: "0" })).toBe(false)
})
