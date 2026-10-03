import { afterEach, expect, test } from "bun:test"
import { ForkCache } from "../src/cache"

afterEach(() => {
  delete process.env.OPENCODE_FORK_CACHE_TTL
})

test("the 1h TTL is opt-in through the environment", () => {
  expect(ForkCache.systemTtl()).toBeUndefined()
  process.env.OPENCODE_FORK_CACHE_TTL = "1h"
  expect(ForkCache.systemTtl()).toBe("1h")
})

test("1h cache writes are billed at 2x input instead of the 5m write price", () => {
  const metadata = { anthropic: { usage: { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } } } }
  // Sonnet-like pricing: $3 input, $3.75 5m write -> 1h write is $6, so $2.25 extra per million.
  expect(ForkCache.extraWriteCost({ metadata, price: { input: 3, cache: { write: 3.75 } } })).toBeCloseTo(2.25)
  expect(ForkCache.extraWriteCost({ metadata: {}, price: { input: 3 } })).toBe(0)
  expect(ForkCache.extraWriteCost({ metadata, price: undefined })).toBe(0)
})
