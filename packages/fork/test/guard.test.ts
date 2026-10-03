import { expect, test } from "bun:test"
import { ForkGuard } from "../src/guard"

test("the request carries the start of the output and one noul", () => {
  const request = ForkGuard.request("x".repeat(5000))
  expect(request.state.length).toBeLessThan(ForkGuard.MAX_CHARS + 100)
  expect(request.questions.injection.type).toBe("noul")
  expect(ForkGuard.probability({ injection: { noul: 0.75 } })).toBe(0.75)
  expect(ForkGuard.probability(undefined)).toBeUndefined()
})

test("a flagged session stays marked for ten minutes", () => {
  ForkGuard.mark("ses_guard", 1_000)
  expect(ForkGuard.recent("ses_guard", 1_000 + ForkGuard.MARK_MS - 1)).toBe(true)
  expect(ForkGuard.recent("ses_guard", 1_000 + ForkGuard.MARK_MS)).toBe(false)
  expect(ForkGuard.recent("ses_other", 1_000)).toBe(false)
})
