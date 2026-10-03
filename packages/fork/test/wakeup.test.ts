import { afterEach, describe, expect, test } from "bun:test"
import { ForkWakeup } from "../src/wakeup"

afterEach(() => {
  delete process.env.OPENCODE_FORK_WAKEUP_MIN_SECONDS
})

describe("plan", () => {
  test("clamps the delay to [60, 3600] and computes the due time", () => {
    const low = ForkWakeup.plan({ delaySeconds: 5, prompt: " check ", reason: "wait" }, 1000)
    expect(low).toMatchObject({ ok: true, stop: false, delaySeconds: 60, due: 61_000, prompt: "check", clamped: true })
    const high = ForkWakeup.plan({ delaySeconds: 99_999, prompt: "x" }, 0)
    expect(high).toMatchObject({ ok: true, delaySeconds: 3600, due: 3_600_000, clamped: true })
    expect(ForkWakeup.plan({ delaySeconds: 300, prompt: "x" }, 0)).toMatchObject({ delaySeconds: 300, clamped: false })
  })

  test("stop needs nothing else, a wakeup needs a delay and a prompt", () => {
    expect(ForkWakeup.plan({ stop: true })).toEqual({ ok: true, stop: true })
    expect(ForkWakeup.plan({ prompt: "x" })).toMatchObject({ ok: false })
    expect(ForkWakeup.plan({ delaySeconds: 60, prompt: "  " })).toMatchObject({ ok: false })
  })

  test("the floor can be lowered for tests", () => {
    process.env.OPENCODE_FORK_WAKEUP_MIN_SECONDS = "1"
    expect(ForkWakeup.plan({ delaySeconds: 1, prompt: "x" }, 0)).toMatchObject({ delaySeconds: 1, due: 1000 })
  })
})

describe("loop", () => {
  test("parses intervals", () => {
    expect(ForkWakeup.parseInterval("5m")).toBe(300_000)
    expect(ForkWakeup.parseInterval("1h")).toBe(3_600_000)
    expect(ForkWakeup.parseInterval("90s")).toBe(90_000)
    expect(ForkWakeup.parseInterval("1.5h")).toBe(5_400_000)
    expect(ForkWakeup.parseInterval("5")).toBeUndefined()
    expect(ForkWakeup.parseInterval("check")).toBeUndefined()
  })

  test("splits the interval from the prompt", () => {
    expect(ForkWakeup.parseLoop("5m check the deploy")).toEqual({ ok: true, prompt: "check the deploy", everyMs: 300_000 })
    expect(ForkWakeup.parseLoop("check the deploy")).toEqual({ ok: true, prompt: "check the deploy" })
    expect(ForkWakeup.parseLoop("5m")).toMatchObject({ ok: false })
    expect(ForkWakeup.parseLoop("  ")).toMatchObject({ ok: false })
  })

  test("an interval below the floor is raised to it", () => {
    expect(ForkWakeup.parseLoop("10s poll")).toMatchObject({ everyMs: 60_000 })
  })

  test("dynamic mode tells the model to reschedule or stop", () => {
    const text = ForkWakeup.loopTemplate({})
    expect(text).toContain("schedule_wakeup")
    expect(text).toContain("stop: true")
    expect(text).toContain("$ARGUMENTS")
    expect(ForkWakeup.loopTemplate({ everyMs: 300_000 })).toContain("every 5 min")
  })

  test("an interval arms a repeating wakeup, dynamic mode arms nothing", () => {
    const id = `ses_wake_${Date.now()}_e`
    expect(ForkWakeup.startLoop(id, "poll the deploy")).toMatchObject({ ok: true, prompt: "poll the deploy" })
    expect(ForkWakeup.get(id)).toBeUndefined()
    expect(ForkWakeup.startLoop(id, "5m poll the deploy", 1000)).toMatchObject({ ok: true, everyMs: 300_000 })
    expect(ForkWakeup.get(id)).toMatchObject({ prompt: "poll the deploy", due: 301_000, every: 300_000 })
    expect(ForkWakeup.startLoop(id, "5m")).toMatchObject({ ok: false })
    ForkWakeup.cancel(id)
  })
})

describe("render", () => {
  test("marks the text as a scheduled wakeup and reads back", () => {
    const text = ForkWakeup.render({ prompt: "check the build", reason: 'wait "CI"', every: null })
    expect(text).toContain("not the user")
    expect(ForkWakeup.received(text)).toEqual({ reason: "wait  CI ", preview: "check the build" })
    expect(ForkWakeup.received("hello")).toBeUndefined()
  })

  test("labels the pending wakeup", () => {
    expect(ForkWakeup.label({ due: 12 * 60_000 }, 0)).toBe("wakeup in 12 min")
    expect(ForkWakeup.label({ due: 0 }, 5)).toBe("wakeup due")
  })
})

describe("storage", () => {
  // The suite runs against the OPENCODE_FORK_DB exported by the caller (never the real fork.db).
  test("one wakeup per session: a new one replaces the old one, stop cancels", () => {
    const id = `ses_wake_${Date.now()}_a`
    ForkWakeup.set({ sessionID: id, due: 10_000, prompt: "first" }, 0)
    ForkWakeup.set({ sessionID: id, due: 20_000, prompt: "second", reason: "r" }, 0)
    expect(ForkWakeup.get(id)).toMatchObject({ prompt: "second", due: 20_000, reason: "r", every: null })
    expect(ForkWakeup.cancel(id)).toBe(true)
    expect(ForkWakeup.get(id)).toBeUndefined()
    expect(ForkWakeup.cancel(id)).toBe(false)
  })

  test("a wakeup is delivered once, when due", () => {
    const id = `ses_wake_${Date.now()}_b`
    ForkWakeup.set({ sessionID: id, due: 10_000, prompt: "later" }, 0)
    expect(ForkWakeup.claimDue(id, 9_999)).toBeUndefined()
    expect(ForkWakeup.claimDue(id, 10_000)?.prompt).toBe("later")
    expect(ForkWakeup.claimDue(id, 99_999)).toBeUndefined()
  })

  test("an overdue wakeup (resume in a new process) is delivered right away", () => {
    const id = `ses_wake_${Date.now()}_c`
    ForkWakeup.set({ sessionID: id, due: 1_000, prompt: "missed" }, 0)
    expect(ForkWakeup.claimDue(id, 500_000)?.prompt).toBe("missed")
  })

  test("a repeating wakeup is re-armed from the delivery", () => {
    const id = `ses_wake_${Date.now()}_d`
    ForkWakeup.set({ sessionID: id, due: 1_000, prompt: "again", everyMs: 60_000 }, 0)
    expect(ForkWakeup.claimDue(id, 2_000)?.prompt).toBe("again")
    expect(ForkWakeup.get(id)?.due).toBe(62_000)
    expect(ForkWakeup.claimDue(id, 3_000)).toBeUndefined()
    ForkWakeup.cancel(id)
  })
})
