import { expect, test } from "bun:test"
import { jsonSchema, tool, type Tool } from "ai"
import { ForkClaudeTools } from "../src/claude-tools"

// One representative Claude Code call per tool.
const CALLS: Record<string, Record<string, unknown>> = {
  Read: { file_path: "/a/b.ts", offset: 10, limit: 20 },
  Write: { file_path: "/a/b.ts", content: "x" },
  Edit: { file_path: "/a/b.ts", old_string: "a", new_string: "b", replace_all: true },
  Bash: { command: "ls", timeout: 5000, description: "List files", run_in_background: true, dangerouslyDisableSandbox: true },
  Glob: { pattern: "src/**/*.ts", path: "/a" },
  Grep: {
    pattern: "foo",
    path: "/a",
    glob: "*.ts",
    type: "ts",
    output_mode: "content",
    "-i": true,
    "-n": false,
    "-A": 1,
    "-B": 2,
    "-C": 3,
    multiline: true,
    head_limit: 10,
  },
  TodoWrite: { todos: [{ content: "Run tests", status: "in_progress", activeForm: "Running tests" }] },
  Agent: {
    description: "Find it",
    prompt: "Look for it",
    subagent_type: "explore",
    run_in_background: true,
    isolation: "worktree",
    resume: "ses_1",
  },
  WebFetch: { url: "https://example.com", prompt: "Summarize" },
  WebSearch: { query: "bun", allowed_domains: ["bun.sh"], blocked_domains: ["spam.com"] },
  AskUserQuestion: {
    questions: [
      { question: "Which?", header: "Pick", options: [{ label: "A", description: "first" }], multiSelect: false },
    ],
  },
  Skill: { skill: "pdf", args: "--fast" },
  ToolSearch: { query: "select:WebFetch,mcp__github__create_issue", max_results: 3 },
  EnterPlanMode: {},
  ExitPlanMode: {},
  TaskOutput: { task_id: "job_1" },
  TaskStop: { task_id: "job_1" },
  Monitor: { id: "job_1", until: "exit" },
  Workflow: { scriptPath: "/a/flow.js", args: { target: "src" }, resumeFromRunId: "wf_1" },
  LSP: { operation: "hover", filePath: "/a/b.ts", line: 1, character: 2 },
  ListMcpResourcesTool: { server: "s" },
  ReadMcpResourceTool: { server: "s", uri: "file:///x" },
}

test("every tool of the table has a sample call", () => {
  expect(
    ForkClaudeTools.table()
      .map((entry) => entry.cc)
      .toSorted(),
  ).toEqual(Object.keys(CALLS).toSorted())
})

test("round trip: the model's call survives persistence and replay unchanged", () => {
  ForkClaudeTools.registerMcp("github_create_issue", "github")
  for (const entry of ForkClaudeTools.table()) {
    const stored = ForkClaudeTools.fromModel(entry.cc, CALLS[entry.cc])
    expect(stored.tool).toBe(entry.native)
    const replay = ForkClaudeTools.toModelCall(stored.tool, stored.input)
    expect(replay.tool).toBe(entry.cc)
    expect(replay.input).toEqual(CALLS[entry.cc])
  }
})

test("an Edit call is stored as edit with opencode's argument names", () => {
  expect(ForkClaudeTools.fromModel("Edit", CALLS.Edit)).toEqual({
    tool: "edit",
    input: { filePath: "/a/b.ts", oldString: "a", newString: "b", replaceAll: true },
  })
})

test("other conversions land in opencode's format", () => {
  expect(ForkClaudeTools.fromModel("Bash", { command: "ls", run_in_background: true }).input).toEqual({
    command: "ls",
    background: true,
  })
  expect(ForkClaudeTools.fromModel("Agent", { description: "d", prompt: "p", subagent_type: "fork" })).toEqual({
    tool: "task",
    input: { description: "d", prompt: "p", subagent_type: "general", inherit: true },
  })
  expect(ForkClaudeTools.fromModel("Agent", { description: "d", prompt: "p", resume: "ses_1" }).input).toEqual({
    description: "d",
    prompt: "p",
    subagent_type: "general",
    task_id: "ses_1",
  })
  expect(ForkClaudeTools.fromModel("Grep", { pattern: "x", glob: "*.ts", "-i": true }).input).toEqual({
    pattern: "x",
    include: "*.ts",
    ignoreCase: true,
    outputMode: "files_with_matches",
  })
  expect(ForkClaudeTools.fromModel("TodoWrite", CALLS.TodoWrite).input).toEqual({
    todos: [{ content: "Run tests", status: "in_progress", activeForm: "Running tests", priority: "medium" }],
  })
  expect(ForkClaudeTools.fromModel("Skill", { skill: "pdf" }).input).toEqual({ name: "pdf" })
  expect(ForkClaudeTools.fromModel("ToolSearch", { query: "select:WebFetch,Read" }).input).toEqual({
    query: "select:webfetch,read",
  })
})

test("calls already in opencode's format pass through untouched", () => {
  const input = { filePath: "/a", oldString: "a", newString: "b" }
  expect(ForkClaudeTools.fromModel("edit", input)).toEqual({ tool: "edit", input })
  const grep = { pattern: "x", include: "*.ts" }
  expect(ForkClaudeTools.fromModel("grep", grep)).toEqual({ tool: "grep", input: grep })
})

test("replayed history is the same on every turn", () => {
  const history = [
    { tool: "edit", input: { filePath: "/a", oldString: "a", newString: "b" } },
    { tool: "task", input: { description: "d", prompt: "p", subagent_type: "explore", background: true } },
    { tool: "todowrite", input: { todos: [{ content: "x", status: "pending", priority: "high" }] } },
    { tool: "unknown_custom", input: { a: 1 } },
  ]
  const turn = () => JSON.stringify(history.map((call) => ForkClaudeTools.toModelCall(call.tool, call.input)))
  const first = turn()
  expect(turn()).toBe(first)
  expect(JSON.parse(first)[2].input.todos[0]).toEqual({ content: "x", status: "pending", activeForm: "x" })
  expect(JSON.parse(first)[3]).toEqual({ tool: "unknown_custom", input: { a: 1 } })
})

test("MCP tools use the mcp__server__tool form in both directions", () => {
  ForkClaudeTools.registerMcp("my_server_create_issue", "my_server")
  expect(ForkClaudeTools.toModelName("my_server_create_issue")).toBe("mcp__my_server__create_issue")
  expect(ForkClaudeTools.toNativeName("mcp__my_server__create_issue")).toBe("my_server_create_issue")
  expect(ForkClaudeTools.fromModel("mcp__my_server__create_issue", { a: 1 })).toEqual({
    tool: "my_server_create_issue",
    input: { a: 1 },
  })
})

test("names mangled by opencode-claude-auth still resolve", () => {
  expect(ForkClaudeTools.toNativeName("todoWrite")).toBe("todowrite")
  expect(ForkClaudeTools.toNativeName("askUserQuestion")).toBe("question")
  expect(ForkClaudeTools.toNativeName("bash")).toBe("bash")
  expect(ForkClaudeTools.toNativeName("webFetch")).toBe("webfetch")
  expect(ForkClaudeTools.repairName("todoWrite", ["TodoWrite", "Read"])).toBe("TodoWrite")
  expect(ForkClaudeTools.repairName("read", ["Read"])).toBe("Read")
  expect(ForkClaudeTools.repairName("Read", ["Read"])).toBeUndefined()
  expect(ForkClaudeTools.repairName("nope", ["Read"])).toBeUndefined()
})

test("the profile applies to Anthropic models only, and can be turned off", () => {
  expect(ForkClaudeTools.enabled({ providerID: "anthropic" })).toBe(true)
  expect(ForkClaudeTools.enabled({ providerID: "custom", api: { npm: "@ai-sdk/anthropic" } })).toBe(true)
  expect(ForkClaudeTools.enabled({ providerID: "openai", api: { npm: "@ai-sdk/openai" } })).toBe(false)
  process.env.OPENCODE_FORK_CC_TOOLS = "0"
  expect(ForkClaudeTools.enabled({ providerID: "anthropic" })).toBe(false)
  delete process.env.OPENCODE_FORK_CC_TOOLS
})

const make = (description: string, calls: unknown[], output = "ok") =>
  tool({
    description,
    inputSchema: jsonSchema({ type: "object" }),
    execute: async (args: unknown) => {
      calls.push(args)
      return { title: "", metadata: {}, output }
    },
  })

test("wrap renames tools, runs them with opencode's arguments and hides apply_patch", async () => {
  const edit: unknown[] = []
  const websearch: unknown[] = []
  const webfetch: unknown[] = []
  const tools: Record<string, Tool> = {
    edit: make("native edit", edit),
    websearch: make("native websearch", websearch),
    webfetch: make("native webfetch", webfetch, "<page>"),
    read: make("native read", []),
    apply_patch: make("patch", []),
    invalid: make("Do not use", []),
    github_create_issue: make("mcp", []),
    task: make("native task\nAvailable agent types and the tools they have access to:\n- explore: finds things", []),
  }
  ForkClaudeTools.registerMcp("github_create_issue", "github")
  const wrapped = ForkClaudeTools.wrap(tools)
  expect(Object.keys(wrapped).toSorted()).toEqual(
    ["Agent", "Edit", "WebFetch", "WebSearch", "Read", "invalid", "mcp__github__create_issue"].toSorted(),
  )
  expect(wrapped.Edit.description).not.toBe("native edit")
  expect(wrapped.Agent.description).toContain("- explore: finds things")
  expect(JSON.stringify(wrapped.Edit.inputSchema)).toContain("file_path")

  const options = { toolCallId: "c", messages: [] }
  await wrapped.Edit.execute?.({ file_path: "/a", old_string: "a", new_string: "b" }, options)
  expect(edit[0]).toEqual({ filePath: "/a", oldString: "a", newString: "b" })

  await wrapped.WebSearch.execute?.({ query: "bun", allowed_domains: ["bun.sh"], blocked_domains: ["x.com"] }, options)
  expect((websearch[0] as { query: string }).query).toBe("bun (site:bun.sh) -site:x.com")

  const fetched = await wrapped.WebFetch.execute?.({ url: "https://e.com", prompt: "title?" }, options)
  expect((fetched as { output: string }).output).toBe("Apply this request to the page content below: title?\n\n<page>")
  expect(webfetch[0]).toEqual({ url: "https://e.com", prompt: "title?" })
})

test("grep arguments and result follow Claude Code semantics", () => {
  const args = ForkClaudeTools.grepArgs(
    { pattern: "foo", outputMode: "content", include: "*.ts", ignoreCase: true, context: 2, lineNumbers: false },
    "/repo",
  )
  expect(args).toContain("--glob=*.ts")
  expect(args).toContain("--ignore-case")
  expect(args).toContain("--context=2")
  expect(args).toContain("--no-line-number")
  expect(args.slice(-3)).toEqual(["--", "foo", "/repo"])
  expect(ForkClaudeTools.grepArgs({ pattern: "x" }, "/r")).toContain("--files-with-matches")
  expect(ForkClaudeTools.grepArgs({ pattern: "x", outputMode: "count" }, "/r")).toContain("--count")

  expect(ForkClaudeTools.grepResult({ pattern: "x" }, []).output).toBe("No files found")
  expect(ForkClaudeTools.grepResult({ pattern: "x" }, ["/a", "/b"]).output).toBe("Found 2 files\n/a\n/b")
  const limited = ForkClaudeTools.grepResult({ pattern: "x", outputMode: "content", headLimit: 1 }, ["a:1:x", "b:2:x"])
  expect(limited.output).toContain("a:1:x")
  expect(limited.output).not.toContain("b:2:x")
  expect(limited.metadata.truncated).toBe(true)
})

test("prompt text names the Claude tools", () => {
  const text = ForkClaudeTools.prompt("call plan_exit; use the question tool; the Task tool; the edit tool")
  expect(text).toBe("call ExitPlanMode; use the AskUserQuestion tool; the Agent tool; the Edit tool")
})

test("prompt does not claim a second identity next to the Claude Code one", () => {
  const text = ForkClaudeTools.prompt("You are OpenCode, the best coding agent on the planet.\n\nRest.")
  expect(text).toBe("Rest.")
})

test("Bash dangerouslyDisableSandbox maps to sandbox: false", () => {
  expect(ForkClaudeTools.fromModel("Bash", { command: "ls", dangerouslyDisableSandbox: true }).input).toEqual({
    command: "ls",
    sandbox: false,
  })
  expect(ForkClaudeTools.fromModel("Bash", { command: "ls", dangerouslyDisableSandbox: false }).input).toEqual({
    command: "ls",
  })
  expect(ForkClaudeTools.toModelCall("bash", { command: "ls", sandbox: false }).input).toEqual({
    command: "ls",
    dangerouslyDisableSandbox: true,
  })
})
