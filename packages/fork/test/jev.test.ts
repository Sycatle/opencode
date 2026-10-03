import { expect, test } from "bun:test"
import { ForkJev } from "../src/jev"

const body = {
  answers: {
    a: { type: "noul", noul: 0.8, confidence: 0.9 },
    b: { type: "score", score: 3, confidence: 0.5 },
    c: { type: "choice", choice: "done" },
    skipped: "nope",
  },
}

function fake(status: number, payload: unknown) {
  const seen: { url: string; init: RequestInit | undefined }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify(payload), { status })
  }) as typeof fetch
  return { seen, fetcher }
}

const env = { TYPESAFE_API_KEY: "k", OPENCODE_FORK_JEV_URL: "http://jev.test/", OPENCODE_FORK_JEV_MODEL: "m" }
const input = { state: "s", questions: { a: { type: "noul" as const, instructions: "q" } } }

test("a feature is off without a key or with its switch at 0, shadow and on are explicit", () => {
  expect(ForkJev.mode("X", {})).toBe("off")
  expect(ForkJev.mode("X", { TYPESAFE_API_KEY: "k" })).toBe("on")
  expect(ForkJev.mode("X", { TYPESAFE_API_KEY: "k" }, "off")).toBe("off")
  expect(ForkJev.mode("X", { TYPESAFE_API_KEY: "k", OPENCODE_FORK_X_JEV: "0" })).toBe("off")
  expect(ForkJev.mode("X", { TYPESAFE_API_KEY: "k", OPENCODE_FORK_X_JEV: "shadow" })).toBe("shadow")
  expect(ForkJev.mode("X", { TYPESAFE_API_KEY: "k", OPENCODE_FORK_X_JEV: "1" }, "off")).toBe("on")
})

test("endpoint, model and timeout come from OPENCODE_FORK_JEV_*", () => {
  expect(ForkJev.endpoint({})).toBe("https://api.typesafe.ai/v1/systemone")
  expect(ForkJev.endpoint({ OPENCODE_FORK_JEV_URL: "http://x/" })).toBe("http://x/v1/systemone")
  expect(ForkJev.model({})).toBe("jev-latest")
  expect(ForkJev.timeout({})).toBe(1500)
  expect(ForkJev.timeout({ OPENCODE_FORK_JEV_TIMEOUT_MS: "300" })).toBe(300)
  expect(ForkJev.timeout({ OPENCODE_FORK_JEV_TIMEOUT_MS: "abc" })).toBe(1500)
})

test("answers keep the usable fields, level maps 0..3 to 0..1, confidence is the mean", () => {
  const answers = ForkJev.answers(body)
  expect(Object.keys(answers ?? {})).toEqual(["a", "b", "c"])
  expect(answers?.a).toEqual({ choice: undefined, score: undefined, noul: 0.8, confidence: 0.9 })
  expect(ForkJev.level(answers?.b)).toBe(1)
  expect(ForkJev.level(answers?.a)).toBeUndefined()
  expect(ForkJev.confidence(answers ?? {})).toBeCloseTo(0.7, 9)
  expect(ForkJev.confidence({ c: { choice: "x" } })).toBeUndefined()
  expect(ForkJev.answers({})).toBeUndefined()
  expect(ForkJev.answers({ answers: [] })).toBeUndefined()
})

test("ask posts the state, the model and the questions with a bearer token", async () => {
  const { seen, fetcher } = fake(200, body)
  const result = await ForkJev.ask(input, env, fetcher)
  expect(result.answers?.a?.noul).toBe(0.8)
  expect(seen[0]?.url).toBe("http://jev.test/v1/systemone")
  expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer k")
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ state: "s", model: "m", questions: input.questions })
})

test("HTTP errors, unusable bodies, network failures and timeouts are errors with a latency", async () => {
  expect((await ForkJev.ask(input, env, fake(500, {}).fetcher)).error).toBe("Jev returned HTTP 500")
  expect((await ForkJev.ask(input, env, fake(200, {}).fetcher)).error).toBe("Jev response unusable")
  const down = (async () => {
    throw new Error("connection refused")
  }) as unknown as typeof fetch
  const failed = await ForkJev.ask(input, env, down)
  expect(failed.error).toContain("connection refused")
  expect(failed.ms).toBeGreaterThanOrEqual(0)
  const hang = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch
  expect((await ForkJev.ask(input, { ...env, OPENCODE_FORK_JEV_TIMEOUT_MS: "20" }, hang)).error).toStartWith("Jev request failed")
})
