import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import { ForkCompactionLog } from "../src/compaction-log"
import { ForkCompactionTiming } from "../src/compaction-timing"

process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-compaction-timing-${process.pid}-${Date.now()}.db`)

// Sonnet-like prices per million tokens.
const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const cfg = { at: 0.5, coldAt: 0.3, minTurns: 3 }

const base: ForkCompactionTiming.Input = {
  phase: "end",
  context: 120_000,
  window: 200_000,
  base: 15_000,
  tail: 8_000,
  price,
  idleMs: 0,
  ttlMs: ForkCompactionTiming.WARM_TTL_MS,
  toolLoop: false,
  todos: [],
  background: false,
  planMode: false,
  turnsSince: Infinity,
  remaining: 10,
}

const decide = (input: Partial<ForkCompactionTiming.Input> = {}) =>
  ForkCompactionTiming.decide({ ...base, ...input }, cfg)

test("compacts at a task boundary above the threshold when it pays", () => {
  const result = decide()
  expect(result.compact).toBe(true)
  expect(result.code).toBe("boundary")
  expect(result.benefit).toBeGreaterThan(result.cost)
})

test("a completed todo list is a boundary, an open one is not", () => {
  expect(decide({ todos: [{ status: "completed" }, { status: "completed" }] }).code).toBe("boundary")
  const open = decide({ todos: [{ status: "completed" }, { status: "in_progress" }] })
  expect(open.compact).toBe(false)
  expect(open.code).toBe("task-open")
})

test("stays below the intermediate threshold", () => {
  const result = decide({ context: 80_000 })
  expect(result.compact).toBe(false)
  expect(result.code).toBe("below-threshold")
})

test("never compacts in a tool loop, with background work, in plan mode, or right after a compaction", () => {
  expect(decide({ toolLoop: true }).code).toBe("tool-loop")
  expect(decide({ background: true }).code).toBe("background")
  expect(decide({ planMode: true }).code).toBe("plan-mode")
  expect(decide({ turnsSince: 2 }).code).toBe("recent-compaction")
  expect(decide({ turnsSince: 3 }).compact).toBe(true)
})

test("a cold cache lowers the threshold and decides at the start of the next turn", () => {
  const cold = { idleMs: ForkCompactionTiming.WARM_TTL_MS + 1, context: 70_000 }
  const start = decide({ ...cold, phase: "start" })
  expect(start.compact).toBe(true)
  expect(start.code).toBe("cold-cache")
  expect(start.threshold).toBe(0.3)
  expect(start.benefit).toBeGreaterThan(start.cost)
})

test("a warm start waits for the end of the turn, and a cold start does not need a boundary", () => {
  expect(decide({ phase: "start" }).code).toBe("warm")
  const cold = decide({ phase: "start", idleMs: ForkCompactionTiming.WARM_TTL_MS + 1, todos: [{ status: "pending" }] })
  expect(cold.compact).toBe(true)
})

test("a cold cache compacts where a warm one does not pay", () => {
  const warm = decide({ context: 110_000, remaining: 3 })
  expect(warm.code).toBe("not-worth")
  expect(warm.benefit).toBeLessThan(warm.cost)
  expect(decide({ context: 110_000, remaining: 3, phase: "start", idleMs: ForkCompactionTiming.WARM_TTL_MS + 1 }).compact).toBe(true)
})

test("the benefit grows with the remaining turns", () => {
  const few = ForkCompactionTiming.pays({ ...base, remaining: 1 }, false)
  const many = ForkCompactionTiming.pays({ ...base, remaining: 20 }, false)
  expect(few.pays).toBe(false)
  expect(many.pays).toBe(true)
  expect(many.benefit).toBeGreaterThan(few.benefit)
  expect(many.cost).toBe(few.cost)
})

test("a free model never pays", () => {
  const result = decide({ price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  expect(result.compact).toBe(false)
  expect(result.code).toBe("no-price")
})

test("remaining turns follow the calls per prompt so far, within bounds", () => {
  expect(ForkCompactionTiming.remainingTurns(0, 0)).toBe(3)
  expect(ForkCompactionTiming.remainingTurns(2, 20)).toBe(10)
  expect(ForkCompactionTiming.remainingTurns(1, 500)).toBe(40)
})

test("settings read the environment, as a ratio or a percentage", () => {
  const keys = ["OPENCODE_FORK_COMPACT_AT", "OPENCODE_FORK_COMPACT_COLD_AT", "OPENCODE_FORK_COMPACT_MIN_TURNS"] as const
  const saved = keys.map((key) => process.env[key])
  try {
    process.env.OPENCODE_FORK_COMPACT_AT = "60"
    process.env.OPENCODE_FORK_COMPACT_COLD_AT = "0.2"
    process.env.OPENCODE_FORK_COMPACT_MIN_TURNS = "5"
    expect(ForkCompactionTiming.settings()).toEqual({ at: 0.6, coldAt: 0.2, minTurns: 5 })
    process.env.OPENCODE_FORK_COMPACT_AT = "nope"
    expect(ForkCompactionTiming.settings().at).toBe(0.5)
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]
      else process.env[key] = saved[i]
    })
  }
})

test("opt-out", () => {
  const saved = process.env.OPENCODE_FORK_SMART_COMPACTION
  try {
    expect(ForkCompactionTiming.enabled()).toBe(true)
    process.env.OPENCODE_FORK_SMART_COMPACTION = "0"
    expect(ForkCompactionTiming.enabled()).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_FORK_SMART_COMPACTION
    else process.env.OPENCODE_FORK_SMART_COMPACTION = saved
  }
})

test("the journal keeps every decision of a session in order", () => {
  const decisions = [decide(), decide({ toolLoop: true })]
  decisions.forEach((decision, i) =>
    ForkCompactionLog.record({ sessionID: "ses_a", messageID: `msg_${i}`, phase: "end", decision }),
  )
  ForkCompactionLog.record({ sessionID: "ses_b", messageID: "msg_x", phase: "start", decision: decide() })
  const rows = ForkCompactionLog.list("ses_a")
  expect(rows.map((row) => [row.compact, row.code])).toEqual([
    [1, "boundary"],
    [0, "tool-loop"],
  ])
  expect(rows[0].context).toBe(120_000)
})

test("an unlikely task boundary delays the compaction until the window is nearly full, and never a cold cache", () => {
  const delayed = decide({ boundary: 0.2 })
  expect(delayed.compact).toBe(false)
  expect(delayed.code).toBe("not-boundary")
  expect(decide({ boundary: 0.8 }).code).toBe("boundary")
  expect(decide({ boundary: 0.2, context: 150_000 }).code).toBe("boundary")
  expect(decide({ boundary: 0.2, idleMs: ForkCompactionTiming.WARM_TTL_MS + 1 }).code).toBe("cold-cache")
  expect(decide({ boundary: undefined }).code).toBe("boundary")
})

test("the Jev request carries the last exchange and the open todos", () => {
  const request = ForkCompactionTiming.jevRequest({ user: "ship it", reply: "Done.", todos: 2 })
  expect(request.state).toContain("User's last message:\nship it")
  expect(request.state).toContain("End of the agent's reply:\nDone.")
  expect(request.state).toContain("Open todos: 2.")
  expect(request.questions.boundary.type).toBe("noul")
})
