import { jsonSchema, type Tool } from "ai"

// Claude tool profile. Claude models are trained on Claude Code's tools, so for an Anthropic
// model the tool map is presented under Claude Code's names and parameter shapes. Everything
// stored (messages, parts, permissions, plugin hooks, TUI) stays in opencode's format:
//   - outbound: tools map (`wrap`) and replayed history (`toModelCall`)
//   - inbound:  the model's calls are converted back (`fromModel`) before they are persisted
// All conversions are pure and deterministic so that replayed history never changes between turns.

type Args = Record<string, unknown>
type Schema = Record<string, unknown>

interface Spec {
  native: string
  cc: string
  // Claude Code parameter -> opencode parameter. Unlisted parameters keep their name.
  keys?: Record<string, string>
  // Applied after the key rename, only to calls the model made under the Claude Code name.
  toNative?: (args: Args) => Args
  toCC?: (args: Args) => Args
  // Arguments used to run the tool, when they differ from the ones that are persisted.
  exec?: (args: Args) => Args
  // Adjusts the tool output, given the Claude Code arguments.
  post?: (args: Args, output: string) => string
  // Omitted: reuse the opencode schema and description.
  schema?: Schema
  description?: string
}

const MAX_NAME = 64

export function enabled(model: { providerID: string; api?: { npm?: string } }) {
  if (process.env.OPENCODE_FORK_CC_TOOLS === "0") return false
  const npm = model.api?.npm
  return model.providerID === "anthropic" || npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic"
}

// ---------------------------------------------------------------- argument helpers

function rename(args: Args, keys: Record<string, string>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [keys[key] ?? key, value]))
}

function invert(keys: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(keys ?? {}).map(([cc, native]) => [native, cc]))
}

function isArgs(value: unknown): value is Args {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mapItems(value: unknown, fn: (item: Args) => Args) {
  return Array.isArray(value) ? value.map((item) => (isArgs(item) ? fn(item) : item)) : value
}

function without(args: Args, ...keys: string[]) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)))
}

// ---------------------------------------------------------------- schemas

function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  }
}

const str = (description: string): Schema => ({ type: "string", description })
const num = (description: string): Schema => ({ type: "number", description })
const bool = (description: string): Schema => ({ type: "boolean", description })

const TASK_ID_NOTE = "Id returned when the job was started."

// ---------------------------------------------------------------- specs

const SPECS: Spec[] = [
  {
    native: "read",
    cc: "Read",
    keys: { file_path: "filePath" },
    schema: object(
      {
        file_path: str("Absolute path of the file or directory to read."),
        offset: num("Line to start from, counting from 1. Only needed for long files."),
        limit: num("Number of lines to read. Only needed for long files."),
      },
      ["file_path"],
    ),
    description: [
      "Reads a file or lists a directory from the local filesystem. Use absolute paths.",
      "- Returns up to 2000 lines by default, each prefixed with its line number; pass offset (first line is 1) and limit to page through long files.",
      "- Very long lines are cut. Images and PDFs come back as attachments.",
      "- Prefer reading several likely files in parallel over probing one at a time.",
      "- Reading is required before Edit or Write may change an existing file.",
    ].join("\n"),
  },
  {
    native: "write",
    cc: "Write",
    keys: { file_path: "filePath" },
    schema: object(
      {
        file_path: str("Absolute path of the file to write."),
        content: str("Full content of the file."),
      },
      ["file_path", "content"],
    ),
    description: [
      "Creates a file, or replaces an existing one, with the given content.",
      "- An existing file must have been read in this conversation first.",
      "- Prefer Edit for changes to existing files; use Write for new files or complete rewrites.",
      "- Do not create documentation or README files unless the user asks for them.",
    ].join("\n"),
  },
  {
    native: "edit",
    cc: "Edit",
    keys: { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
    schema: object(
      {
        file_path: str("Absolute path of the file to modify."),
        old_string: str("Exact text to replace."),
        new_string: str("Replacement text. Must differ from old_string."),
        replace_all: bool("Replace every occurrence instead of requiring a unique match. Defaults to false."),
      },
      ["file_path", "old_string", "new_string"],
    ),
    description: [
      "Replaces an exact piece of text in a file.",
      "- Read the file first in this conversation.",
      "- old_string must match the file character for character, indentation included, but without the line-number prefix that Read shows.",
      "- The edit fails when old_string is not unique: include more surrounding context, or set replace_all to change every occurrence (handy for renames).",
      "- Prefer editing existing files to creating new ones.",
    ].join("\n"),
  },
  {
    native: "bash",
    cc: "Bash",
    keys: { run_in_background: "background" },
    schema: object(
      {
        command: str("The command to run."),
        timeout: num("Timeout in milliseconds."),
        description: str("Short, plain-language summary of what the command does."),
        run_in_background: bool(
          "Run the command in the background; you are notified when it exits. Do not poll or sleep waiting for it.",
        ),
      },
      ["command"],
    ),
    description: [
      "Runs a shell command in the project directory and returns its output.",
      "- Quote paths that contain spaces. Avoid cd; use absolute paths instead.",
      "- Use Read, Edit, Write, Glob and Grep rather than cat, sed, echo > or find/grep when they can do the job.",
      "- Output is truncated when very long; the command is stopped when timeout (milliseconds) elapses.",
      "- Independent commands can go in separate parallel calls; chain dependent ones with && in a single call.",
      "- Commands that must outlive the call (servers, watchers, long builds) belong in run_in_background; read them with TaskOutput and stop them with TaskStop.",
      "- Never run destructive or irreversible commands (force pushes, hard resets, deleting data) unless the user asked for exactly that.",
    ].join("\n"),
  },
  {
    native: "glob",
    cc: "Glob",
    schema: object(
      {
        pattern: str("Glob pattern to match, such as src/**/*.ts."),
        path: str("Directory to search in. Omit it to search the working directory."),
      },
      ["pattern"],
    ),
    description: [
      "Finds files by name using a glob pattern and returns their paths.",
      "- Works on repositories of any size.",
      "- For open-ended exploration that needs several rounds of searching, delegate to the Agent tool instead.",
      "- Run several searches in parallel when they are independent.",
    ].join("\n"),
  },
  {
    native: "grep",
    cc: "Grep",
    keys: {
      glob: "include",
      output_mode: "outputMode",
      "-i": "ignoreCase",
      "-n": "lineNumbers",
      "-A": "after",
      "-B": "before",
      "-C": "context",
      head_limit: "headLimit",
    },
    toNative: (args) => ({ ...args, outputMode: args.outputMode ?? "files_with_matches" }),
    schema: object(
      {
        pattern: str("Regular expression to look for."),
        path: str("File or directory to search. Defaults to the working directory."),
        glob: str('Only search files matching this glob, for example "*.js" or "*.{ts,tsx}".'),
        type: str("Only search this ripgrep file type, for example js, py or rust."),
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            'What to return: "content" shows matching lines, "files_with_matches" lists file paths (default), "count" gives the number of matches per file.',
        },
        "-i": bool("Ignore case."),
        "-n": bool('Show line numbers in "content" mode. Defaults to true.'),
        "-A": num('Lines of context to show after each match ("content" mode).'),
        "-B": num('Lines of context to show before each match ("content" mode).'),
        "-C": num('Lines of context to show around each match ("content" mode).'),
        multiline: bool("Let patterns span lines, with . also matching newlines. Defaults to false."),
        head_limit: num("Return only the first N results (default 250, 0 means no limit)."),
      },
      ["pattern"],
    ),
    description: [
      "Searches file contents with ripgrep and regular expressions.",
      "- Always use this instead of running grep or rg through Bash.",
      "- Narrow the search with glob or type; choose output_mode according to whether you need paths, lines or counts.",
      "- Patterns use ripgrep (Rust) syntax, so literal braces must be escaped. Use multiline for patterns that cross line breaks.",
      "- For open-ended exploration that needs several rounds of searching, delegate to the Agent tool instead.",
    ].join("\n"),
  },
  {
    native: "todowrite",
    cc: "TodoWrite",
    toNative: (args) => ({
      ...args,
      todos: mapItems(args.todos, (item) => ({ ...item, priority: item.priority ?? "medium" })),
    }),
    toCC: (args) => ({
      ...args,
      todos: mapItems(args.todos, (item) => ({
        ...without(item, "priority"),
        activeForm: item.activeForm ?? item.content,
      })),
    }),
    schema: object(
      {
        todos: {
          type: "array",
          description: "The complete, updated todo list.",
          items: object(
            {
              content: str("Imperative description of the task, e.g. Run the tests."),
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task state." },
              activeForm: str("Present-continuous wording shown while the task runs, e.g. Running the tests."),
            },
            ["content", "status", "activeForm"],
          ),
        },
      },
      ["todos"],
    ),
    description: [
      "Maintains a structured task list for the current session.",
      "- Use it for work with three or more steps, several user requests, or when the user asks for a list; skip it for trivial one-step work.",
      "- Send the whole list each time. Keep exactly one task in_progress, and mark tasks completed as soon as they are done and verified.",
      "- If something blocks a task, leave it in_progress and add a task describing what is needed.",
      "- Every task has content (imperative) and activeForm (present continuous).",
    ].join("\n"),
  },
  {
    native: "task",
    cc: "Agent",
    keys: { run_in_background: "background", resume: "task_id" },
    toNative: (args) => {
      if (args.subagent_type === "fork") return { ...args, subagent_type: "general", inherit: true }
      return { ...args, subagent_type: args.subagent_type ?? "general" }
    },
    toCC: (args) => {
      if (args.inherit === true) return { ...without(args, "inherit"), subagent_type: "fork" }
      return args
    },
    schema: object(
      {
        description: str("Short (3-5 words) label for the job."),
        prompt: str("Complete instructions for the agent."),
        subagent_type: str('Agent type to run. "fork" continues from a copy of the current conversation.'),
        run_in_background: bool("Run asynchronously; you are notified when the agent finishes."),
        isolation: { type: "string", enum: ["worktree"], description: "Run the agent in an isolated git worktree." },
        resume: str("Id of an earlier agent run to continue instead of starting a new one."),
      },
      ["description", "prompt"],
    ),
    description: [
      "Starts a subagent that works on a multi-step job on its own.",
      '- Pick the agent with subagent_type. With subagent_type "fork" the agent starts from a copy of this conversation, so it needs a directive rather than background.',
      "- Not for reading a known file, finding a specific symbol or searching two or three files: use Read, Glob or Grep directly.",
      "- Start independent agents in parallel (several calls in one message) and do not repeat work you handed over.",
      "- A fresh agent knows nothing about this conversation: say what to find or change, whether code may be written, how to verify, and what to report.",
      "- Its final message is not shown to the user; summarize the result yourself. The result carries an id that resume accepts to continue the same agent.",
      '- run_in_background returns immediately and notifies you on completion; isolation "worktree" gives the agent its own checkout.',
    ].join("\n"),
  },
  {
    native: "webfetch",
    cc: "WebFetch",
    // The prompt cannot be answered by a model here, so it travels with the page content instead.
    post: (args, output) =>
      typeof args.prompt === "string" && args.prompt
        ? `Apply this request to the page content below: ${args.prompt}\n\n${output}`
        : output,
    schema: object(
      {
        url: { type: "string", format: "uri", description: "Fully formed URL to fetch." },
        prompt: str("What to extract or answer from the page."),
      },
      ["url", "prompt"],
    ),
    description: [
      "Fetches a web page and returns its content as markdown, together with your request.",
      "- HTTP URLs are upgraded to HTTPS. Read-only; large pages are truncated.",
      "- Use it for pages you already have a URL for; prefer a more specific tool when one exists, for example an MCP tool.",
    ].join("\n"),
  },
  {
    native: "websearch",
    cc: "WebSearch",
    exec: (args) => {
      const allowed = Array.isArray(args.allowed_domains) ? args.allowed_domains.map(String) : []
      const blocked = Array.isArray(args.blocked_domains) ? args.blocked_domains.map(String) : []
      const parts = [
        typeof args.query === "string" ? args.query : "",
        allowed.length ? `(${allowed.map((domain) => `site:${domain}`).join(" OR ")})` : "",
        ...blocked.map((domain) => `-site:${domain}`),
      ]
      return { ...args, query: parts.filter(Boolean).join(" ") }
    },
    schema: object(
      {
        query: str("Search query."),
        allowed_domains: {
          type: "array",
          items: { type: "string" },
          description: "Only return results from these domains.",
        },
        blocked_domains: {
          type: "array",
          items: { type: "string" },
          description: "Never return results from these domains.",
        },
      },
      ["query"],
    ),
    description: [
      "Searches the web and returns result snippets with their sources.",
      "- Use it for current events or facts newer than your training data; take the current date into account in queries.",
      "- Cite the sources you rely on.",
    ].join("\n"),
  },
  {
    native: "question",
    cc: "AskUserQuestion",
    toNative: (args) => ({
      ...args,
      questions: mapItems(args.questions, (item) => rename(item, { multiSelect: "multiple" })),
    }),
    toCC: (args) => ({
      ...args,
      questions: mapItems(args.questions, (item) => ({
        ...without(item, "multiple"),
        multiSelect: item.multiple === true,
      })),
    }),
    schema: object(
      {
        questions: {
          type: "array",
          description: "Questions to ask the user.",
          items: object(
            {
              question: str("The complete question, ending with a question mark."),
              header: str("Very short label (at most 12 characters) shown as a chip."),
              options: {
                type: "array",
                description: "The choices. The user can always type another answer.",
                items: object(
                  { label: str("Choice text, 1-5 words."), description: str("What picking this choice means.") },
                  ["label", "description"],
                ),
              },
              multiSelect: bool("Allow several choices to be selected."),
            },
            ["question", "header", "options", "multiSelect"],
          ),
        },
      },
      ["questions"],
    ),
    description: [
      "Asks the user one or more multiple-choice questions and waits for the answers.",
      "- Use it to settle ambiguity, pick between approaches or gather preferences while you work.",
      "- Put the option you recommend first. Do not ask whether a plan is acceptable; use ExitPlanMode for that.",
    ].join("\n"),
  },
  {
    native: "skill",
    cc: "Skill",
    keys: { skill: "name" },
    post: (args, output) =>
      typeof args.args === "string" && args.args ? `${output}\n\nARGUMENTS: ${args.args}` : output,
    schema: object({ skill: str("Name of the skill to run."), args: str("Optional arguments for the skill.") }, [
      "skill",
    ]),
    description: [
      "Loads a skill: specialised instructions and resources for a kind of task.",
      "- Call it when the request matches one of the skills listed in the system prompt, before doing the work.",
      "- Do not call it for a skill that is already loaded in this conversation.",
    ].join("\n"),
  },
  {
    native: "tool_search",
    cc: "ToolSearch",
    toNative: (args) => ({ ...args, query: mapSelect(args.query, toNativeName) }),
    toCC: (args) => ({ ...args, query: mapSelect(args.query, toModelName) }),
    schema: object(
      {
        query: str('Keywords, or "select:<tool>[,<tool>...]" to load exact tools.'),
        max_results: num("Maximum number of keyword matches to load (default 5)."),
      },
      ["query"],
    ),
  },
  { native: "plan_enter", cc: "EnterPlanMode" },
  { native: "plan_exit", cc: "ExitPlanMode" },
  {
    native: "shell_output",
    cc: "TaskOutput",
    keys: { task_id: "id" },
    schema: object({ task_id: str(`Id of the background job. ${TASK_ID_NOTE}`) }, ["task_id"]),
    description: [
      "Returns the most recent output of a background Bash job, without waiting for it to end.",
      "- Do not poll in a loop; you are notified when the job exits.",
    ].join("\n"),
  },
  {
    native: "shell_kill",
    cc: "TaskStop",
    keys: { task_id: "id" },
    schema: object({ task_id: str(`Id of the background job to stop. ${TASK_ID_NOTE}`) }, ["task_id"]),
    description: "Stops a running background Bash job.",
  },
  { native: "monitor", cc: "Monitor" },
  { native: "lsp", cc: "LSP" },
  { native: "list_mcp_resources", cc: "ListMcpResourcesTool" },
  { native: "read_mcp_resource", cc: "ReadMcpResourceTool" },
]

export function table() {
  return SPECS.map((spec) => ({ native: spec.native, cc: spec.cc }))
}

const BY_NATIVE = new Map(SPECS.map((spec) => [spec.native, spec]))
const BY_CC = new Map(SPECS.map((spec) => [spec.cc, spec]))
// opencode-claude-auth lowercases the first letter of the tool names it strips of its mcp_ prefix.
const BY_LOWERED = new Map(SPECS.map((spec) => [lowerFirst(spec.cc), spec]))

// opencode does not expose apply_patch to Anthropic models; Edit and Write cover it.
const HIDDEN = new Set(["apply_patch"])

function lowerFirst(name: string) {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

// ---------------------------------------------------------------- names

const MCP_PREFIX = "mcp__"
// opencode MCP key (server_tool) -> Claude Code name (mcp__server__tool); filled while tools are resolved.
const mcpNames = new Map<string, string>()

export function registerMcp(key: string, server: string) {
  const name = `${MCP_PREFIX}${server}__${key.slice(server.length + 1)}`
  if (name.length <= MAX_NAME) mcpNames.set(key, name)
}

export function toModelName(name: string) {
  return BY_NATIVE.get(name)?.cc ?? mcpNames.get(name) ?? name
}

export function toNativeName(name: string) {
  const spec = BY_CC.get(name) ?? BY_LOWERED.get(name)
  if (spec) return spec.native
  if (!name.startsWith(MCP_PREFIX)) return name
  const rest = name.slice(MCP_PREFIX.length)
  const split = rest.indexOf("__")
  return split < 0 ? name : `${rest.slice(0, split)}_${rest.slice(split + 2)}`
}

// ---------------------------------------------------------------- calls

function toNativeArgs(spec: Spec, args: Args) {
  const renamed = spec.keys ? rename(args, spec.keys) : args
  return spec.toNative ? spec.toNative(renamed) : renamed
}

function toCCArgs(spec: Spec, args: Args) {
  const renamed = spec.keys ? rename(args, invert(spec.keys)) : args
  return spec.toCC ? spec.toCC(renamed) : renamed
}

// The tool defined under a differently cased or opencode-style name for a call that matched none.
export function repairName(name: string, available: string[]) {
  if (available.includes(name)) return undefined
  const native = toNativeName(name)
  return available.find((key) => toNativeName(key) === native)
}

// A call the model made, as it must be persisted. Calls under a native name (other providers,
// sessions that switched model) are already in opencode's format and pass through untouched.
export function fromModel(name: string, args: Args) {
  const spec = BY_CC.get(name)
  return { tool: toNativeName(name), input: spec ? toNativeArgs(spec, args) : args }
}

// A stored call, as it must be replayed to the model.
export function toModelCall(name: string, args: unknown) {
  const spec = BY_NATIVE.get(name)
  return { tool: toModelName(name), input: spec && isArgs(args) ? toCCArgs(spec, args) : args }
}

// ---------------------------------------------------------------- tool map

const AGENT_LIST = "Available agent types and the tools they have access to:"

function describe(spec: Spec, native: string | undefined) {
  if (!spec.description) return native
  if (spec.native !== "task") return spec.description
  const index = native?.indexOf(AGENT_LIST) ?? -1
  return index < 0 ? spec.description : `${spec.description}\n${native?.slice(index)}`
}

// Renames the tool map to Claude Code's names and shapes. Arguments are converted back before the
// original tool runs, so permissions, plugin hooks and persistence only ever see opencode's format.
export function wrap(tools: Record<string, Tool>) {
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([name]) => !HIDDEN.has(name))
      .map(([name, original]): [string, Tool] => {
        const spec = BY_NATIVE.get(name)
        if (!spec) return [toModelName(name), original]
        const execute = original.execute
        return [
          spec.cc,
          {
            ...original,
            description: describe(spec, original.description),
            inputSchema: spec.schema ? jsonSchema(spec.schema) : original.inputSchema,
            execute: execute
              ? async (args, options) => {
                  const given = isArgs(args) ? args : {}
                  const native = toNativeArgs(spec, given)
                  const result = await execute(spec.exec ? spec.exec(native) : native, options)
                  if (!spec.post || !isArgs(result) || typeof result.output !== "string") return result
                  return { ...result, output: spec.post(given, result.output) }
                }
              : undefined,
          } as Tool,
        ]
      }),
  )
}

// opencode-only parameters are not offered to models that do not use the Claude tool profile.
const GREP_EXTRAS = [
  "outputMode",
  "ignoreCase",
  "lineNumbers",
  "after",
  "before",
  "context",
  "multiline",
  "type",
  "headLimit",
]

export function nativeSchema<T extends { properties?: unknown }>(id: string, schema: T): T {
  if (id !== "grep" || !isArgs(schema.properties)) return schema
  return { ...schema, properties: without(schema.properties, ...GREP_EXTRAS) }
}

// The `select:A,B` form of tool_search names tools; keywords are left alone.
function mapSelect(query: unknown, name: (tool: string) => string) {
  if (typeof query !== "string" || !query.startsWith("select:")) return query
  const names = query.slice("select:".length).split(",")
  return `select:${names.map((item) => name(item.trim())).join(",")}`
}

// Presents a deferred tool the way `wrap` will once it is loaded.
export function describeTool(native: string, description: string | undefined) {
  const spec = BY_NATIVE.get(native)
  return spec ? describe(spec, description) : description
}

// ---------------------------------------------------------------- grep

export interface GrepParams {
  pattern: string
  include?: string
  type?: string
  outputMode?: "content" | "files_with_matches" | "count"
  ignoreCase?: boolean
  lineNumbers?: boolean
  after?: number
  before?: number
  context?: number
  multiline?: boolean
  headLimit?: number
}

const DEFAULT_HEAD_LIMIT = 250
const MAX_HEAD_LIMIT = 10_000

export function grepLimit(params: GrepParams) {
  if (params.headLimit === 0) return MAX_HEAD_LIMIT
  return Math.min(params.headLimit ?? DEFAULT_HEAD_LIMIT, MAX_HEAD_LIMIT)
}

// ripgrep arguments for a Claude Code style search of `target` (an absolute file or directory).
export function grepArgs(params: GrepParams, target: string) {
  const mode = params.outputMode ?? "files_with_matches"
  return [
    "--no-config",
    "--hidden",
    "--no-messages",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--sort=path",
    "--glob=!**/.git/**",
    ...(params.include ? [`--glob=${params.include}`] : []),
    ...(params.type ? [`--type=${params.type}`] : []),
    ...(params.ignoreCase ? ["--ignore-case"] : []),
    ...(params.multiline ? ["--multiline", "--multiline-dotall"] : []),
    ...(mode === "files_with_matches" ? ["--files-with-matches"] : []),
    ...(mode === "count" ? ["--count"] : []),
    ...(mode === "content"
      ? [
          params.lineNumbers === false ? "--no-line-number" : "--line-number",
          "--max-columns=500",
          "--max-columns-preview",
          ...(params.context !== undefined ? [`--context=${params.context}`] : []),
          ...(params.after !== undefined ? [`--after-context=${params.after}`] : []),
          ...(params.before !== undefined ? [`--before-context=${params.before}`] : []),
        ]
      : []),
    "--",
    params.pattern,
    target,
  ]
}

export function grepResult(params: GrepParams, lines: readonly string[]) {
  const limit = grepLimit(params)
  const mode = params.outputMode ?? "files_with_matches"
  const truncated = lines.length > limit
  const shown = lines.slice(0, limit)
  const none = mode === "files_with_matches" ? "No files found" : "No matches found"
  const header = mode === "files_with_matches" ? `Found ${shown.length} file${shown.length === 1 ? "" : "s"}\n` : ""
  const note = truncated ? `\n\n[Showing the first ${limit} results. Narrow the search or raise head_limit.]` : ""
  return {
    title: params.pattern,
    metadata: { matches: shown.length, truncated },
    output: shown.length ? `${header}${shown.join("\n")}${note}` : none,
  }
}

// ---------------------------------------------------------------- prompts

// Names the Claude tools in prompt text written with opencode's tool names.
const PROMPT_NAMES: [string, string][] = [
  ["question tool", "AskUserQuestion tool"],
  ["plan_exit", "ExitPlanMode"],
  ["plan_enter", "EnterPlanMode"],
  ["edit tool", "Edit tool"],
  ["write tool", "Write tool"],
  ["Task tool", "Agent tool"],
]

export function prompt(text: string) {
  return PROMPT_NAMES.reduce((result, [from, to]) => result.replaceAll(from, to), text)
}

export * as ForkClaudeTools from "./claude-tools"
