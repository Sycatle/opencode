import { expect, test } from "bun:test"
import { jsonSchema, tool, type Tool } from "ai"
import { ForkTools } from "../src/tools"

const make = (description: string) => tool({ description, inputSchema: jsonSchema({ type: "object" }) })

const toolset = (): Record<string, Tool> => ({
  read: make("Read a file"),
  "chrome_click": make("Click an element in the browser page"),
  "chrome_navigate": make("Navigate the browser to a URL"),
  "wayland_screenshot": make("Capture a screenshot of the desktop"),
})
const deferrable = ["chrome_click", "chrome_navigate", "wayland_screenshot", "not_present"]

const searchCall = (loaded: string[]) => ({
  parts: [{ type: "tool", tool: ForkTools.SEARCH, state: { status: "completed", metadata: { loaded } } }],
})

test("withholds deferrable tools and exposes tool_search listing them", () => {
  const tools = ForkTools.defer(toolset(), deferrable, [])
  expect(Object.keys(tools).toSorted()).toEqual(["read", ForkTools.SEARCH])
  const description = tools[ForkTools.SEARCH].description ?? ""
  expect(description).toContain("chrome_click")
  expect(description).toContain("wayland_screenshot")
  expect(description).not.toContain("not_present")
})

test("keeps tools loaded by a previous search or already used in history", () => {
  const tools = ForkTools.defer(toolset(), deferrable, [
    searchCall(["chrome_navigate"]),
    { parts: [{ type: "tool", tool: "wayland_screenshot", state: { status: "completed" } }] },
  ])
  expect(Object.keys(tools).toSorted()).toEqual(
    ["chrome_navigate", "read", ForkTools.SEARCH, "wayland_screenshot"].toSorted(),
  )
})

test("tool_search description is stable while tools get loaded", () => {
  const before = ForkTools.defer(toolset(), deferrable, [])[ForkTools.SEARCH].description
  const after = ForkTools.defer(toolset(), deferrable, [searchCall(["chrome_click"])])[ForkTools.SEARCH].description
  expect(after).toBe(before)
})

test("ignores failed searches", () => {
  const tools = ForkTools.defer(toolset(), deferrable, [
    { parts: [{ type: "tool", tool: ForkTools.SEARCH, state: { status: "error", metadata: { loaded: ["chrome_click"] } } }] },
  ])
  expect("chrome_click" in tools).toBe(false)
})

test("search selects exact names or ranks keyword matches", () => {
  const pool = toolset()
  expect(ForkTools.search(pool, "select:chrome_click, nope ,read")).toEqual(["chrome_click", "read"])
  expect(ForkTools.search(pool, "browser")[0]).toMatch(/^chrome_/)
  expect(ForkTools.search(pool, "screenshot")).toEqual(["wayland_screenshot"])
  expect(ForkTools.search(pool, "zzz")).toEqual([])
})

test("tool_search execute reports loaded names in metadata", async () => {
  const tools = ForkTools.defer(toolset(), deferrable, [])
  const result = await tools[ForkTools.SEARCH].execute!({ query: "select:chrome_click" }, { toolCallId: "1", messages: [] })
  expect(result.metadata).toEqual({ loaded: ["chrome_click"] })
})

test("is a no-op without deferrable tools or when disabled", () => {
  expect(Object.keys(ForkTools.defer(toolset(), ["absent"], []))).not.toContain(ForkTools.SEARCH)
  process.env.OPENCODE_FORK_DEFER_TOOLS = "0"
  expect(Object.keys(ForkTools.defer(toolset(), deferrable, []))).toHaveLength(4)
  delete process.env.OPENCODE_FORK_DEFER_TOOLS
})

const withNative = (value: string | undefined, run: () => void) => {
  const previous = process.env.OPENCODE_FORK_DEFER_NATIVE
  if (value === undefined) delete process.env.OPENCODE_FORK_DEFER_NATIVE
  else process.env.OPENCODE_FORK_DEFER_NATIVE = value
  try {
    run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_FORK_DEFER_NATIVE
    else process.env.OPENCODE_FORK_DEFER_NATIVE = previous
  }
}

test("nativeDeferrable parses the env: default, disabled, CSV override", () => {
  withNative(undefined, () => expect(ForkTools.nativeDeferrable()).toContain("webfetch"))
  withNative("0", () => expect(ForkTools.nativeDeferrable()).toEqual([]))
  withNative(" lsp, question ,,", () => expect(ForkTools.nativeDeferrable()).toEqual(["lsp", "question"]))
})

test("native tools are deferred, listed sorted, and stay loaded once used in history", () => {
  const native = () => ({ ...toolset(), webfetch: make("Fetch a URL"), lsp: make("Language server") })
  const names = ["webfetch", "lsp"]
  const tools = ForkTools.defer(native(), names, [])
  expect("webfetch" in tools || "lsp" in tools).toBe(false)
  const description = tools[ForkTools.SEARCH].description ?? ""
  expect(description.indexOf("lsp")).toBeLessThan(description.indexOf("webfetch"))
  const used = ForkTools.defer(native(), names, [
    { parts: [{ type: "tool", tool: "webfetch", state: { status: "completed" } }] },
  ])
  expect("webfetch" in used).toBe(true)
  expect("lsp" in used).toBe(false)
  expect(used[ForkTools.SEARCH].description).toBe(description)
})
