import { expect, test } from "bun:test"
import { ForkAutonomy } from "../src/autonomy"

const base = { command: "bun test", iteration: 1, maxIterations: 3, spent: 0, budget: 1, sessionID: "s" }

test("stops when the check passes, the budget is spent, or iterations run out", () => {
  expect(ForkAutonomy.decide({ ...base, check: { code: 0, output: "" } })).toEqual({
    action: "done",
    reason: "check-passed",
  })
  expect(ForkAutonomy.decide({ ...base, check: { code: 1, output: "" }, spent: 1 })).toEqual({
    action: "stop",
    reason: "budget",
  })
  expect(ForkAutonomy.decide({ ...base, check: { code: 1, output: "" }, iteration: 3 })).toEqual({
    action: "stop",
    reason: "iterations",
  })
  expect(ForkAutonomy.decide({ ...base, check: { code: 0, output: "" }, sessionID: undefined })).toEqual({
    action: "stop",
    reason: "no-session",
  })
})

test("a failed check is fed back with its exit code and the tail of its output", () => {
  const decision = ForkAutonomy.decide({ ...base, check: { code: 2, output: "x".repeat(5000) + "LAST LINE" } })
  if (decision.action !== "continue") throw new Error("expected continue")
  expect(decision.prompt).toContain("`bun test` failed (exit code 2)")
  expect(decision.prompt).toContain("LAST LINE")
  expect(decision.prompt.length).toBeLessThan(4400)
})

test("keeps runtime flags before a dev script and ignores them for a compiled binary", () => {
  expect(
    ForkAutonomy.selfCommand("/usr/bin/bun", ["/usr/bin/bun", "/repo/src/index.ts"], ["--conditions=browser"]),
  ).toEqual(["/usr/bin/bun", "--conditions=browser", "/repo/src/index.ts"])
  expect(ForkAutonomy.selfCommand("/bin/opencode", ["/bin/opencode", "/$bunfs/root/opencode"], ["--x"])).toEqual([
    "/bin/opencode",
  ])
})

test("re-invokes a dev script with its runtime, a compiled binary alone", () => {
  expect(ForkAutonomy.selfCommand("/usr/bin/bun", ["/usr/bin/bun", "/repo/src/index.ts", "auto"])).toEqual([
    "/usr/bin/bun",
    "/repo/src/index.ts",
  ])
  expect(ForkAutonomy.selfCommand("/bin/opencode", ["/bin/opencode", "/$bunfs/root/opencode", "auto"])).toEqual([
    "/bin/opencode",
  ])
})

test("budgets are USD by default and 5-hour window points with %", () => {
  expect(ForkAutonomy.parseBudget(undefined)).toBeUndefined()
  expect(ForkAutonomy.parseBudget("0.5")).toEqual({ unit: "usd", amount: 0.5 })
  expect(ForkAutonomy.parseBudget("$2")).toEqual({ unit: "usd", amount: 2 })
  expect(ForkAutonomy.parseBudget(" 20% ")).toEqual({ unit: "window", amount: 20 })
  expect(() => ForkAutonomy.parseBudget("lots")).toThrow()
})
