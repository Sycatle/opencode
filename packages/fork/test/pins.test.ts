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
  expect(ForkPins.format([{ message_id: "m", text: "line one\nline two", time: 0 }])).toBe(
    "## Pinned (verbatim)\n- line one\n  line two",
  )
})
