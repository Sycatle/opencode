import { expect, test } from "bun:test"
import { ForkCompaction } from "../src/compaction"

test("recall returns the last request only while the cache is likely warm", () => {
  ForkCompaction.remember("s1", "m1", { value: 1 })
  ForkCompaction.remember("s1", "m2", { value: 2 })
  expect(ForkCompaction.recall<{ value: number }>("s1")).toMatchObject({ messageID: "m2", input: { value: 2 } })
  expect(ForkCompaction.recall("s1", Date.now() + ForkCompaction.WARM_MS + 1)).toBeUndefined()
  expect(ForkCompaction.recall("other")).toBeUndefined()
  ForkCompaction.forget("s1")
  expect(ForkCompaction.recall("s1")).toBeUndefined()
})

test("a summary is acceptable only without tool calls and with real content", () => {
  expect(ForkCompaction.acceptable({ text: "x".repeat(300), toolCalls: 0 })).toBe(true)
  expect(ForkCompaction.acceptable({ text: "x".repeat(300), toolCalls: 1 })).toBe(false)
  expect(ForkCompaction.acceptable({ text: "too short", toolCalls: 0 })).toBe(false)
})

const assistant = (parts: Parameters<typeof ForkCompaction.facts>[0][number]["parts"]) => ({
  info: { role: "assistant" },
  parts,
})

test("facts come from patches, the last todo list and recent tool errors", () => {
  const facts = ForkCompaction.facts([
    { info: { role: "user" }, parts: [{ type: "text" }] },
    assistant([
      { type: "patch", files: ["src/a.ts", "src/b.ts"] },
      {
        type: "tool",
        tool: "todowrite",
        state: { status: "completed", input: { todos: [{ content: "old", status: "pending" }] } },
      },
    ]),
    assistant([
      { type: "patch", files: ["src/a.ts", "src/c.ts"] },
      {
        type: "tool",
        tool: "todowrite",
        state: {
          status: "completed",
          input: { todos: [{ content: "fix bug", status: "completed" }, { content: "add test", status: "in_progress" }] },
        },
      },
      { type: "tool", tool: "bash", state: { status: "error", error: "exit code 1: tests failed" } },
    ]),
  ])
  expect(facts.files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
  expect(facts.todos).toEqual([
    { content: "fix bug", status: "completed" },
    { content: "add test", status: "in_progress" },
  ])
  expect(facts.errors).toEqual(["bash: exit code 1: tests failed"])
})

test("facts carry over from the previous summary across compactions", () => {
  const previous = { files: ["src/old.ts"], todos: [{ content: "keep me", status: "pending" }], errors: ["stale"] }
  const facts = ForkCompaction.facts([
    assistant([{ type: "text", metadata: { forkFacts: previous } }]),
    assistant([{ type: "patch", files: ["src/new.ts"] }]),
  ])
  expect(facts.files).toEqual(["src/old.ts", "src/new.ts"])
  expect(facts.todos).toEqual(previous.todos)
  expect(facts.errors).toEqual([])
})

test("formatFacts renders only non-empty sections", () => {
  expect(ForkCompaction.formatFacts({ files: [], todos: [], errors: [] })).toBeUndefined()
  expect(
    ForkCompaction.formatFacts({ files: ["src/a.ts"], todos: [{ content: "x", status: "pending" }], errors: [] }),
  ).toBe("## Modified Files\n- src/a.ts\n\n## Todo List\n- [pending] x")
})

test("replaying from cache is chosen only when cheaper than the upstream transcript", () => {
  // 17k cached context + 3k uncached tail vs a 2.7k truncated transcript: upstream wins.
  expect(ForkCompaction.worthIt({ context: 17_000, delta: 3_000, legacy: 2_700, cacheRatio: 0.1 })).toBe(false)
  // 150k cached context + 5k tail vs a 47k transcript: replay wins.
  expect(ForkCompaction.worthIt({ context: 150_000, delta: 5_000, legacy: 47_000, cacheRatio: 0.1 })).toBe(true)
  // No cache discount (unknown pricing): never worth it.
  expect(ForkCompaction.worthIt({ context: 150_000, delta: 5_000, legacy: 47_000, cacheRatio: 1 })).toBe(false)
})

test("the transcript estimate truncates tool outputs like upstream", () => {
  const huge = { type: "tool", tool: "read", state: { status: "completed", input: {}, output: "x".repeat(100_000) } }
  const small = ForkCompaction.transcriptTokens([{ parts: [{ type: "text", text: "y".repeat(400) }] }])
  const withTool = ForkCompaction.transcriptTokens([{ parts: [{ type: "text", text: "y".repeat(400) }, huge] }])
  expect(withTool - small).toBeLessThan(600)
  const cleared = { ...huge, state: { ...huge.state, time: { compacted: 1 } } }
  expect(ForkCompaction.transcriptTokens([{ parts: [cleared] }])).toBeLessThan(withTool)
})

test("preview reports both costs and the path the arbitration would take", () => {
  expect(ForkCompaction.preview({ context: 150_000, delta: 5_000, legacy: 47_000, cacheRatio: 0.1 })).toEqual({
    cached: 20_000,
    legacy: 47_000,
    path: "cached",
  })
  expect(ForkCompaction.preview({ context: 17_000, delta: 3_000, legacy: 2_700, cacheRatio: 0.1 }).path).toBe("legacy")
})
