import { describe, expect, test } from "bun:test"
import { current, cycle, draftMode, modeRule, resetDraftMode, storedMode, withMode, type Rule } from "./fork-mode"

const auto: Rule = { permission: "fork.mode", pattern: "auto", action: "allow" }
const other: Rule = { permission: "bash", pattern: "rm *", action: "deny" }

describe("fork mode", () => {
  test("stores the mode as a marker rule and keeps the other rules", () => {
    expect(withMode([other], "auto")).toEqual([other, auto])
    expect(withMode([other, auto], "normal")).toEqual([other])
    expect(storedMode([auto, other])).toBe("auto")
    expect(storedMode([{ ...auto, pattern: "acceptEdits" }])).toBe("normal")
    expect(storedMode([other])).toBeUndefined()
  })

  test("cycles build, plan, auto on a session and saves what changed", async () => {
    const saved: Rule[][] = []
    let agent = "build"
    let rules: Rule[] = [other]
    const step = async () => {
      const mode = cycle({
        sessionID: "ses_cycle",
        rules,
        agent,
        setAgent: (name) => (agent = name),
        // The server appends what it receives to the stored rules.
        save: async (next) => {
          saved.push(next)
          rules = [...rules, ...next]
        },
        onError: (error) => {
          throw error
        },
      })
      await Promise.resolve()
      return mode
    }

    expect(await step()).toBe("plan")
    expect(agent).toBe("plan")
    expect(saved.at(-1)).toEqual([modeRule("normal")])

    expect(await step()).toBe("auto")
    expect(agent).toBe("build")
    expect(saved.at(-1)).toEqual([auto])
    expect(storedMode(rules)).toBe("auto")

    expect(await step()).toBe("normal")
    expect(agent).toBe("build")
    expect(saved.at(-1)).toEqual([modeRule("normal")])
    // Leaving auto must really clear it on a server that only appends, without duplicating the other rules.
    expect(storedMode(rules)).toBe("normal")
    expect(rules.filter((rule) => rule.permission === "bash")).toEqual([other])
  })

  test("a draft session keeps the mode until it is created", () => {
    resetDraftMode()
    let agent = "build"
    const press = () =>
      cycle({
        sessionID: undefined,
        rules: undefined,
        agent,
        setAgent: (name) => (agent = name),
        save: async () => {
          throw new Error("a draft has no session to save to")
        },
        onError: () => {},
      })

    expect(press()).toBe("plan")
    expect(draftMode()).toBe("normal")
    expect(press()).toBe("auto")
    expect(draftMode()).toBe("auto")
    expect(current(undefined, undefined, agent)).toBe("auto")
    resetDraftMode()
    expect(draftMode()).toBe("normal")
  })
})
