import { expect, test } from "bun:test"
import { ForkContext } from "../src/context"

test("prune is on unless explicitly disabled", () => {
  expect(ForkContext.pruneEnabled(undefined)).toBe(true)
  expect(ForkContext.pruneEnabled(true)).toBe(true)
  expect(ForkContext.pruneEnabled(false)).toBe(false)
})

test("pruned stub names the tool, its title and the cleared size", () => {
  expect(ForkContext.prunedStub({ tool: "read", state: { title: "src/cart.ts", output: "a\nb\nc" } })).toBe(
    "[Old result of read src/cart.ts cleared (3 lines). Re-run the tool if you need it again.]",
  )
})
