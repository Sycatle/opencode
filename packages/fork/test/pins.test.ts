import { expect, test } from "bun:test"
import os from "os"
import path from "path"

// Always a fresh database: an inherited OPENCODE_FORK_DB may hold rows from earlier runs.
process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-pins-${process.pid}-${Date.now()}.db`)
const { ForkPins } = await import("../src/pins")

test("toggling pins and unpins a message, per session", () => {
  expect(ForkPins.toggle("pins-a", "m1", "Always use pnpm")).toBe(true)
  ForkPins.toggle("pins-a", "m2", "Target Node 22")
  ForkPins.toggle("pins-b", "m1", "other session")
  expect(ForkPins.list("pins-a").map((pin) => pin.text)).toEqual(["Always use pnpm", "Target Node 22"])
  expect(ForkPins.toggle("pins-a", "m1", "Always use pnpm")).toBe(false)
  expect(ForkPins.list("pins-a").map((pin) => pin.message_id)).toEqual(["m2"])
})

test("pins are formatted verbatim, multi-line text indented under its bullet", () => {
  expect(ForkPins.format([])).toBeUndefined()
  expect(ForkPins.format([{ message_id: "m", text: "line one\nline two", time: 0, auto: 0 }])).toBe(
    "## Pinned (verbatim)\n- line one\n  line two",
  )
})

test("automatic pins are idempotent, never override a user pin and are marked auto", () => {
  ForkPins.toggle("pins-c", "m1", "user pin")
  expect(ForkPins.add("pins-c", "m1", "user pin")).toBe(false)
  expect(ForkPins.add("pins-c", "m2", "Never touch the legacy API")).toBe(true)
  expect(ForkPins.add("pins-c", "m2", "Never touch the legacy API")).toBe(false)
  expect(ForkPins.list("pins-c").map((pin) => [pin.message_id, pin.auto])).toEqual([
    ["m1", 0],
    ["m2", 1],
  ])
})

test("candidates are the recent long unpinned messages, one noul per candidate, picks respect the limits", () => {
  const long = "x".repeat(60)
  const messages = [
    { message_id: "short", text: "ok go" },
    { message_id: "pinned", text: long },
    ...Array.from({ length: 8 }, (_, index) => ({ message_id: `m${index}`, text: `${long}${index}` })),
  ]
  const items = ForkPins.candidates(messages, [{ message_id: "pinned", text: "", time: 0, auto: 0 }])
  expect(items.map((item) => item.message_id)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"])
  const request = ForkPins.jevRequest(items)
  expect(Object.keys(request.questions)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"])
  expect(request.state).toContain("[m0]\n" + `${long}2`)
  const answers = { m0: { noul: 0.95 }, m1: { noul: 0.5 }, m2: { noul: 0.85 }, m3: { noul: 0.9 }, m4: { noul: 0.81 } }
  expect(ForkPins.picks(items, answers, 0).map((item) => item.message_id)).toEqual(["m2", "m5", "m4"])
  expect(ForkPins.picks(items, answers, 7)).toHaveLength(1)
  expect(ForkPins.picks(items, answers, 8)).toEqual([])
})
