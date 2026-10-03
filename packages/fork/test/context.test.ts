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

const item = (id: string, tokens: number) => ({ id, tool: "read", title: id, excerpt: `content of ${id}`, tokens })

test("prune asks about the largest outputs, one noul each", () => {
  const batch = Array.from({ length: 25 }, (_, index) => item(`p${index}`, 100 + index))
  const asked = ForkContext.pruneAsk(batch)
  expect(asked).toHaveLength(20)
  expect(asked[0]?.id).toBe("p24")
  const request = ForkContext.pruneRequest(asked.slice(0, 2), "fix the parser")
  expect(Object.keys(request.questions)).toEqual(["p0", "p1"])
  expect(request.state).toContain("Current request:\nfix the parser")
  expect(request.state).toContain("[p0] read p24\ncontent of p24")
})

test("prune keeps the likeliest outputs, at most a quarter of the batch, only while the rest is worth pruning", () => {
  const items = [item("a", 5000), item("b", 4000), item("c", 3000), item("d", 2000)]
  const answers = { p0: { noul: 0.9 }, p1: { noul: 0.95 }, p2: { noul: 0.4 }, p3: { noul: 0.85 } }
  // 4 outputs in the batch: one fits in a quarter, the likeliest.
  expect([...ForkContext.pruneKeeps(items, answers, { count: 4, tokens: 30_000 }, 20_000)]).toEqual(["b"])
  expect([...ForkContext.pruneKeeps(items, answers, { count: 8, tokens: 30_000 }, 20_000)]).toEqual(["b", "a"])
  // Keeping them would leave too little to prune.
  expect(ForkContext.pruneKeeps(items, answers, { count: 8, tokens: 24_000 }, 20_000).size).toBe(0)
  expect(ForkContext.pruneKeeps(items, { p0: { noul: 0.5 } }, { count: 8, tokens: 30_000 }, 20_000).size).toBe(0)
})
