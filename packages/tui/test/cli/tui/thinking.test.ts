import { describe, expect, test } from "bun:test"
import type { Part, ReasoningPart } from "@opencode-ai/sdk/v2"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { opaqueReasoningGroups, reasoningSummary } from "../../../src/context/thinking"

const opaque = (index: number, end?: number): ReasoningPart => ({
  id: `reason-${index}`,
  messageID: "message",
  sessionID: "session",
  type: "reasoning",
  text: "",
  metadata: { openai: { itemId: `item-${index}`, encryptedContent: `encrypted-${index}` } },
  time: { start: index * 100, end },
})

describe("opaqueReasoningGroups", () => {
  test("shows one representative for 148 opaque items without changing replay data", () => {
    const parts = Array.from({ length: 148 }, (_, index) => opaque(index, (index + 1) * 100))
    const before = structuredClone(parts)
    const groups = opaqueReasoningGroups(parts)
    expect([...groups.times]).toEqual([[0, { start: 0, end: 14800 }]])
    expect([...groups.hidden]).toEqual(Array.from({ length: 147 }, (_, index) => index + 1))
    expect(parts).toEqual(before)
  })

  test("keeps text, tools and readable reasoning between groups", () => {
    const parts: Part[] = [
      opaque(0, 100),
      opaque(1, 200),
      { id: "text", messageID: "message", sessionID: "session", type: "text", text: "visible" },
      opaque(3, 400),
      opaque(4, 500),
      {
        id: "tool",
        messageID: "message",
        sessionID: "session",
        type: "tool",
        tool: "monitor",
        callID: "call",
        state: { status: "pending", input: {}, raw: "{}" },
      },
      opaque(6, 700),
      opaque(7, 800),
      { ...opaque(8, 900), text: "**Readable title**\n\nDetails" },
      opaque(9, 1000),
    ]
    const groups = opaqueReasoningGroups(parts)
    expect([...groups.times.keys()]).toEqual([0, 3, 6, 9])
    expect([...groups.hidden]).toEqual([1, 4, 7])
  })

  test("groups redacted placeholders but not empty parts without metadata", () => {
    const parts = [
      opaque(0, 100),
      { ...opaque(1, 200), text: " [REDACTED] " },
      { ...opaque(2), metadata: undefined },
      opaque(3),
    ]
    const groups = opaqueReasoningGroups(parts)
    expect([...groups.times.keys()]).toEqual([0, 3])
    expect([...groups.hidden]).toEqual([1])
  })

  test("stays active until every item ends and closes on message completion or interruption", () => {
    const parts = [opaque(0, 100), opaque(1)]
    expect(opaqueReasoningGroups(parts).times.get(0)).toEqual({ start: 0, end: undefined })
    expect(opaqueReasoningGroups(parts, 300).times.get(0)).toEqual({ start: 0, end: 300 })
    expect(opaqueReasoningGroups([opaque(0), opaque(1, 200)]).times.get(0)?.end).toBeUndefined()
    expect(opaqueReasoningGroups([opaque(0, 100), opaque(1, 200)]).times.get(0)?.end).toBe(200)
  })

  test("updates groups during streaming when items append, end or gain visible text", () => {
    createRoot((dispose) => {
      const [parts, setParts] = createStore<ReasoningPart[]>([opaque(0, 100)])
      const [completed, setCompleted] = createSignal<number>()
      const groups = createMemo(() => opaqueReasoningGroups(parts, completed()))
      expect([...groups().times.keys()]).toEqual([0])
      setParts(1, opaque(1))
      expect([...groups().hidden]).toEqual([1])
      expect(groups().times.get(0)?.end).toBeUndefined()
      setParts(1, "time", "end", 200)
      expect(groups().times.get(0)?.end).toBe(200)
      setParts(0, "text", "Readable streamed summary")
      expect([...groups().times.keys()]).toEqual([1])
      expect([...groups().hidden]).toEqual([])
      setParts(1, "text", "Readable streamed reasoning")
      expect([...groups().hidden]).toEqual([])
      expect(groups().times.size).toBe(0)
      setParts(2, opaque(2))
      setParts(3, opaque(3))
      expect([...groups().times.keys()]).toEqual([2])
      expect([...groups().hidden]).toEqual([3])
      setCompleted(500)
      expect(groups().times.get(2)).toEqual({ start: 200, end: 500 })
      dispose()
    })
  })
})

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })
  })
})
