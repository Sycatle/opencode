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

test("a preloaded part counts as loaded, like a tool_search result", () => {
  const loaded = ForkTools.loadedTools([
    { parts: [{ type: "text", metadata: { forkPreloaded: ["mcp_a", 3, "mcp_b"] } }, { type: "text" }] },
  ])
  expect([...loaded]).toEqual(["mcp_a", "mcp_b"])
})

test("preloading asks about the best keyword matches that are not loaded, and keeps the likely ones", () => {
  const pool = {
    github_create_issue: tool({ description: "Create a GitHub issue", inputSchema: jsonSchema({ type: "object" }) }),
    github_list_prs: tool({ description: "List GitHub pull requests", inputSchema: jsonSchema({ type: "object" }) }),
    slack_post: tool({ description: "Post to Slack", inputSchema: jsonSchema({ type: "object" }) }),
  }
  const names = ForkTools.preloadCandidates(pool, "open a github issue", new Set(["github_list_prs"]))
  expect(names).toEqual(["github_create_issue"])
  const request = ForkTools.preloadRequest(pool, names, "open a github issue")
  expect(request.state).toContain("[t0] github_create_issue: Create a GitHub issue")
  expect(Object.keys(request.questions)).toEqual(["t0"])
  expect(ForkTools.preloadPicks(["a", "b", "c"], { t0: { noul: 0.9 }, t1: { noul: 0.79 } })).toEqual(["a"])
})

test("preloading only happens when the cache holds nothing worth keeping", () => {
  const ttlMs = 5 * 60_000
  expect(ForkTools.preloadWindow({ turnsSinceStart: 0, idleMs: 0, ttlMs })).toBe(true)
  expect(ForkTools.preloadWindow({ turnsSinceStart: 4, idleMs: 60_000, ttlMs })).toBe(false)
  expect(ForkTools.preloadWindow({ turnsSinceStart: 4, idleMs: ttlMs + 1, ttlMs })).toBe(true)
})

test("restoreServerToolNames undoes opencode-claude-auth's prefix on server search tools only", () => {
  const body = JSON.stringify({
    tools: [
      { name: "mcp_Read", input_schema: {} },
      { type: "tool_search_tool_bm25_20251119", name: "mcp_Tool_search_tool_bm25" },
    ],
    messages: [],
  })
  expect(JSON.parse(ForkTools.restoreServerToolNames(body) ?? "{}").tools).toEqual([
    { name: "mcp_Read", input_schema: {} },
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
  ])
  expect(ForkTools.restoreServerToolNames(JSON.stringify({ tools: [{ name: "mcp_Read" }] }))).toBeUndefined()
})

test("nativeSearchOutput reads back the stored references, an unreadable output is an empty result", () => {
  expect(ForkTools.nativeSearchOutput('[{"type":"tool_reference","toolName":"x"}]')).toEqual([
    { type: "tool_reference", toolName: "x" },
  ])
  expect(ForkTools.nativeSearchOutput("[Old tool result content cleared]")).toEqual([])
})
