import { expect, test } from "bun:test"
import path from "path"
import { ForkFlags } from "../src/flags"

const ROOT = path.join(import.meta.dir, "../..")
const SOURCES = ["fork/src", "opencode/src", "tui/src", "core/src"]

// Names read in the sources: literal OPENCODE_FORK_*, ForkFlags.on/raw("X") and the per-feature Jev switches of
// ForkJev.mode("X").
function used() {
  const grep = (pattern: string) =>
    Bun.spawnSync(["grep", "-rhoE", "--include=*.ts", "--include=*.tsx", pattern, ...SOURCES.map((dir) => path.join(ROOT, dir))])
      .stdout.toString()
      .split("\n")
      .filter(Boolean)
  return new Set([
    ...grep("OPENCODE_FORK_[A-Z0-9_]+").map((name) => name.slice("OPENCODE_FORK_".length)),
    ...grep('\\bmode\\("[A-Z_]+"').map((match) => `${match.slice('mode("'.length, -1)}_JEV`),
    ...grep('ForkFlags\\.(on|raw)\\("[A-Z0-9_]+"').map((match) => match.slice(match.indexOf('"') + 1, -1)),
  ])
}

test("every variable the sources read is declared, and nothing declared is unused", async () => {
  const names = used()
  const declared = new Set(Object.keys(ForkFlags.FLAGS))
  expect([...names].filter((name) => !declared.has(name)).toSorted()).toEqual([])
  expect([...declared].filter((name) => !names.has(name)).toSorted()).toEqual([])
})

test("switches are on unless 0, describe reports what is set", () => {
  expect(ForkFlags.on("MESSAGING", {})).toBe(true)
  expect(ForkFlags.on("MESSAGING", { OPENCODE_FORK_MESSAGING: "1" })).toBe(true)
  expect(ForkFlags.on("MESSAGING", { OPENCODE_FORK_MESSAGING: "0" })).toBe(false)
  const rows = ForkFlags.describe({ OPENCODE_FORK_BUDGET_USD: "5" })
  expect(rows.find((row) => row.name === "OPENCODE_FORK_BUDGET_USD")).toMatchObject({ value: "5", set: true })
  expect(rows.find((row) => row.name === "OPENCODE_FORK_MESSAGING")).toMatchObject({ set: false, default: "on" })
})
