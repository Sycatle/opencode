import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { ForkMemory } from "../src/memory"

describe("ForkMemory", () => {
  test("dir is scoped by project under the data dir", () => {
    expect(ForkMemory.dir("abc")).toBe(`${Global.Path.data}/memory/abc`)
  })

  test("readIndex reads MEMORY.md through the injected reader", async () => {
    const files: string[] = []
    const index = await ForkMemory.readIndex("/m", async (file) => {
      files.push(file)
      return "- [A](a.md) — hook\n"
    })
    expect(files).toEqual(["/m/MEMORY.md"])
    expect(index).toBe("- [A](a.md) — hook")
  })

  test("missing or unreadable index is empty", async () => {
    expect(await ForkMemory.readIndex("/nonexistent/dir/for/memory")).toBe("")
    expect(await ForkMemory.readIndex("/m", () => Promise.reject(new Error("boom")).catch(() => ""))).toBe("")
  })

  test("caps lines with a truncation note", () => {
    const text = Array.from({ length: 250 }, (_, i) => `- [T${i}](f${i}.md) — h`).join("\n")
    const out = ForkMemory.cap(text).split("\n")
    expect(out).toHaveLength(ForkMemory.MAX_LINES + 1)
    expect(out.at(-1)).toContain("index truncated: 50 more lines")
  })

  test("caps bytes with a truncation note", () => {
    const text = Array.from({ length: 100 }, () => "x".repeat(200)).join("\n")
    const out = ForkMemory.cap(text)
    expect(Buffer.byteLength(out.split("\n[index truncated")[0])).toBeLessThanOrEqual(ForkMemory.MAX_BYTES)
    expect(out).toContain("index truncated")
  })

  test("render shows empty index and the directory", () => {
    const empty = ForkMemory.render("/data/memory/p", "")
    expect(empty).toContain("/data/memory/p")
    expect(empty).toContain("(empty)")
    expect(ForkMemory.render("/data/memory/p", "- [A](a.md) — h")).toContain("- [A](a.md) — h")
  })

  test("opt-out disables the permission", () => {
    expect(ForkMemory.permission("p")).toHaveProperty("external_directory")
    process.env.OPENCODE_FORK_MEMORY = "0"
    expect(ForkMemory.enabled()).toBe(false)
    expect(ForkMemory.permission("p")).toEqual({})
    delete process.env.OPENCODE_FORK_MEMORY
  })
})
