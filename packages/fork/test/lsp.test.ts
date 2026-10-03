import { describe, expect, test } from "bun:test"
import { ForkLsp } from "@opencode-fork/core/lsp"

const root = "/repo"
const range = (line: number, character: number) => ({
  start: { line, character },
  end: { line, character: character + 3 },
})
const files: Record<string, string> = {
  "/repo/src/a.ts": "export function foo() {}\n\n  const x = foo()\n",
  "/repo/src/long.ts": `const v = "${"x".repeat(300)}"\n`,
}
const read = async (file: string) => files[file]

describe("ForkLsp.format", () => {
  test("Location[] gives path:line:col and trimmed source", async () => {
    const out = await ForkLsp.format(
      "findReferences",
      [
        { uri: "file:///repo/src/a.ts", range: range(0, 16) },
        { uri: "file:///repo/src/a.ts", range: range(2, 12) },
      ],
      { root, read },
    )
    expect(out).toBe("src/a.ts:1:17 export function foo() {}\nsrc/a.ts:3:13 const x = foo()")
  })

  test("LocationLink and missing reader", async () => {
    const link = {
      targetUri: "file:///repo/src/a.ts",
      targetRange: range(0, 0),
      targetSelectionRange: range(0, 16),
    }
    expect(await ForkLsp.format("goToDefinition", [link], { root })).toBe("src/a.ts:1:17")
    expect(await ForkLsp.format("goToImplementation", [link], { root, read })).toBe(
      "src/a.ts:1:17 export function foo() {}",
    )
  })

  test("long source lines are clipped", async () => {
    const out = await ForkLsp.format("goToDefinition", [{ uri: "file:///repo/src/long.ts", range: range(0, 0) }], {
      root,
      read,
    })
    expect(out.length).toBeLessThan(200)
    expect(out.endsWith("…")).toBe(true)
  })

  test("hierarchical DocumentSymbol", async () => {
    const out = await ForkLsp.format(
      "documentSymbol",
      [
        {
          name: "Foo",
          kind: 5,
          range: range(0, 0),
          selectionRange: range(0, 6),
          children: [{ name: "bar", kind: 6, range: range(1, 2), selectionRange: range(1, 2) }],
        },
        { name: "main", kind: 12, range: range(9, 0), selectionRange: range(9, 9) },
      ],
      { root },
    )
    expect(out).toBe("Class Foo 1\n  Method bar 2\nFunction main 10")
  })

  test("SymbolInformation", async () => {
    const out = await ForkLsp.format(
      "workspaceSymbol",
      [{ name: "Session", kind: 11, location: { uri: "file:///repo/src/s.ts", range: range(4, 0) } }],
      { root },
    )
    expect(out).toBe("Interface Session src/s.ts:5")
  })

  test("hover shapes", async () => {
    const markup = { contents: { kind: "markdown", value: "```ts\nfunction foo(): void\n```\n\nDoes foo." } }
    expect(await ForkLsp.format("hover", [markup], { root })).toBe("```ts\nfunction foo(): void\n```\n\nDoes foo.")
    const marked = { contents: [{ language: "ts", value: "const a: 1" }, "doc"] }
    expect(await ForkLsp.format("hover", [marked], { root })).toBe("```ts\nconst a: 1\n```\n\ndoc")
    const big = await ForkLsp.format("hover", [{ contents: "y".repeat(10000) }], { root })
    expect(big.length).toBeLessThan(4100)
    expect(big.endsWith("... truncated")).toBe(true)
  })

  test("call hierarchy", async () => {
    const item = {
      name: "foo",
      kind: 12,
      uri: "file:///repo/src/a.ts",
      range: range(0, 0),
      selectionRange: range(0, 16),
    }
    expect(await ForkLsp.format("prepareCallHierarchy", [item], { root })).toBe("foo Function src/a.ts:1")
    expect(await ForkLsp.format("incomingCalls", [{ from: item, fromRanges: [range(2, 0)] }], { root })).toBe(
      "foo Function src/a.ts:1",
    )
    expect(await ForkLsp.format("outgoingCalls", [{ to: item, fromRanges: [range(2, 0)] }], { root })).toBe(
      "foo Function src/a.ts:1",
    )
  })

  test("caps total lines", async () => {
    const locations = Array.from({ length: 250 }, (_, i) => ({ uri: "file:///repo/src/a.ts", range: range(i, 0) }))
    const lines = (await ForkLsp.format("findReferences", locations, { root })).split("\n")
    expect(lines).toHaveLength(ForkLsp.MAX_LINES + 1)
    expect(lines.at(-1)).toBe("... 50 more")
  })

  test("unknown shapes fall back to compact JSON", async () => {
    expect(await ForkLsp.format("findReferences", [{ foo: 1 }], { root })).toBe('[{"foo":1}]')
    expect(await ForkLsp.format("hover", [null], { root })).toBe("[null]")
  })

  test("enabled honours opt-out", () => {
    const previous = process.env.OPENCODE_FORK_LSP_FORMAT
    process.env.OPENCODE_FORK_LSP_FORMAT = "0"
    expect(ForkLsp.enabled()).toBe(false)
    delete process.env.OPENCODE_FORK_LSP_FORMAT
    expect(ForkLsp.enabled()).toBe(true)
    if (previous !== undefined) process.env.OPENCODE_FORK_LSP_FORMAT = previous
  })
})
