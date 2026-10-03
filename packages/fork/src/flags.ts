export * as ForkFlags from "./flags"

// Every OPENCODE_FORK_* variable the fork reads, in one place: its kind, its default and what it does. Modules
// keep their own accessors; switches read through `on` so the "on unless 0" rule lives here. A test checks that
// every variable read in the sources is declared, and `describe` feeds the "Fork features" dialog.

type Env = Record<string, string | undefined>

type Def = {
  // "switch": on unless "0". "jev": off, shadow or on, per feature (see ForkJev.mode). Others are values.
  kind: "switch" | "jev" | "number" | "text" | "tri"
  // How the default reads to a user; undefined when there is none.
  default?: string
  description: string
}

export const FLAGS = {
  // ---- context and cost
  DEFER_TOOLS: { kind: "switch", default: "on", description: "Withhold MCP and rare native tools behind tool_search" },
  DEFER_NATIVE: {
    kind: "text",
    default: "built-in list",
    description: "Native tools to defer: 0 disables, a comma-separated list overrides",
  },
  SLIM_TOOLS: { kind: "switch", default: "on", description: "Compact descriptions of the native tools" },
  CACHE_TTL: { kind: "text", default: "1h in the TUI", description: "Prompt cache TTL of the stable prefix (set by the TUI)" },
  AUTH_CACHE: {
    kind: "switch",
    default: "on",
    description: "1h breakpoint on the first message under opencode-claude-auth",
  },
  CACHED_COMPACTION: { kind: "switch", default: "on", description: "Summarize by replaying the cached last request" },
  SMART_COMPACTION: { kind: "switch", default: "on", description: "Compact at task boundaries and on a cold cache" },
  COMPACT_AT: { kind: "number", default: "0.5", description: "Context ratio for a task-boundary compaction" },
  COMPACT_COLD_AT: { kind: "number", default: "0.3", description: "Context ratio for a cold-cache compaction" },
  COMPACT_MIN_TURNS: { kind: "number", default: "3", description: "Prompts between two smart compactions" },
  MEMORY: { kind: "switch", default: "on", description: "Inject the project memory index (MEMORY.md)" },
  LSP_FORMAT: { kind: "switch", default: "on", description: "Compact path:line:col output of the lsp tool" },
  SYSTEM_PROMPT: { kind: "switch", default: "on", description: "Fork system prompt for Anthropic models" },
  CC_TOOLS: { kind: "switch", default: "on", description: "Claude Code tool names and schemas for Anthropic models" },
  // ---- budget
  BUDGET_USD: { kind: "number", description: "Dollar budget per session tree: wrap-up at 100%, stop at 120%" },
  BUDGET_WINDOW: { kind: "number", description: "Budget in points of the subscription's 5h window" },
  // ---- agents and jobs
  MAX_BACKGROUND: { kind: "number", default: "4", description: "Concurrent background subagents" },
  ROUTE_SUBAGENTS: { kind: "switch", default: "on", description: "explore subagents run on the small model" },
  SUBAGENT_EFFORT: { kind: "switch", default: "on", description: "Routed subagents use their lowest effort variant" },
  SUBAGENT_INHERIT: { kind: "switch", default: "on", description: "`inherit` parameter of the task tool" },
  BACKGROUND_SHELL: { kind: "switch", default: "on", description: "`background` parameter of bash, shell_output/shell_kill" },
  BACKGROUND_NOTIFY: { kind: "switch", default: "on", description: "Notify when a background job finishes" },
  WORKFLOW_TOOL: { kind: "switch", default: "on", description: "workflow tool" },
  SESSION_WORKTREE: { kind: "switch", default: "on", description: "enter_worktree / exit_worktree tools" },
  MESSAGING: { kind: "switch", default: "on", description: "Messages between live sessions (send_message)" },
  MESSAGING_POLL_MS: { kind: "number", default: "2000", description: "Mailbox poll interval" },
  WAKEUPS: { kind: "switch", default: "on", description: "In-session wakeups (schedule_wakeup, /loop)" },
  WAKEUP_MIN_SECONDS: { kind: "number", description: "Shortest wakeup delay accepted" },
  // ---- permissions and safety
  AUTO_CLASSIFIER: { kind: "switch", default: "on", description: "Auto mode asks the classifier before the user" },
  SANDBOX: { kind: "tri", default: "config", description: "Force the bash sandbox on (1) or off (0)" },
  HOOKS: { kind: "switch", default: "on", description: "Declarative hooks from the config" },
  CC_PLUGINS: { kind: "switch", default: "on", description: "Skills, commands, agents, MCP and hooks of Claude Code plugins" },
  // ---- Router
  ROUTE: { kind: "switch", default: "on", description: "router/* models" },
  ROUTE_TIERS: { kind: "text", default: "derived", description: 'JSON tiers, e.g. {"fast": ["anthropic/claude-haiku-4-5"]}' },
  ROUTE_EXCLUDE: { kind: "text", default: "fable,-fast,-pro,…", description: "Model id fragments the Router never picks" },
  ROUTE_QUOTA: { kind: "number", description: "5h window utilization above which the subscription goes last" },
  ROUTE_TURNS: { kind: "number", default: "6", description: "Expected turns left, for switch costs" },
  ROUTE_RECLASSIFY: { kind: "switch", default: "on", description: "Reuse the previous signals for a short follow-up" },
  ROUTE_EFFORT: { kind: "switch", default: "on", description: "Router picks the effort variant" },
  ROUTE_PLAN: { kind: "switch", default: "on", description: "Router nudges towards plan mode" },
  ROUTE_PLAN_AT: { kind: "number", description: "Plan nudge threshold" },
  ROUTE_ESCALATE: { kind: "switch", default: "on", description: "A struggling turn moves up one tier" },
  // ---- prompt suggestion
  PROMPT_SUGGESTION: { kind: "switch", default: "on", description: "Grey next-prompt suggestion in the TUI" },
  PROMPT_SUGGESTION_JEV_MIN: { kind: "number", description: "Jev probability needed to show a suggestion" },
  // ---- Jev (TypeSafe), only with TYPESAFE_API_KEY
  JEV_URL: { kind: "text", default: "https://api.typesafe.ai", description: "Jev endpoint" },
  JEV_MODEL: { kind: "text", default: "jev-latest", description: "Jev model" },
  JEV_TIMEOUT_MS: { kind: "number", default: "1500", description: "Jev request timeout" },
  ROUTE_JEV: { kind: "jev", default: "on", description: "Router signals" },
  AUTO_CLASSIFIER_JEV: { kind: "jev", default: "on", description: "Auto mode permission verdicts" },
  SMART_COMPACTION_JEV: { kind: "jev", default: "on", description: "Task-boundary check before a compaction" },
  PINS_JEV: { kind: "jev", default: "on", description: "Auto-pin lasting constraints at compaction" },
  PROMPT_SUGGESTION_JEV: { kind: "jev", default: "on", description: "Gate prompt suggestions" },
  INJECTION_JEV: { kind: "jev", default: "on", description: "Flag prompt injection in webfetch output" },
  INJECTION_MCP_JEV: { kind: "jev", default: "off", description: "Flag prompt injection in MCP output" },
  PRUNE_JEV: { kind: "jev", default: "off", description: "Keep likely-needed tool outputs at prune" },
  DEFER_TOOLS_JEV: { kind: "jev", default: "off", description: "Preload the deferred tools a request needs" },
  AUTO_JEV: { kind: "jev", default: "on", description: "`opencode auto` judges completion without --until" },
  // ---- internal
  INTERACTIVE: { kind: "text", default: "set by the TUI", description: "Marks an interactive session" },
  REMOTE: { kind: "text", default: "set by attach", description: "The TUI is attached to a server on another machine" },
  DB: { kind: "text", default: "<data>/fork.db", description: "Fork database path" },
} satisfies Record<string, Def>

export type Name = keyof typeof FLAGS
type SwitchName = { [K in Name]: (typeof FLAGS)[K]["kind"] extends "switch" ? K : never }[Name]

export const key = (name: Name) => `OPENCODE_FORK_${name}`

export function on(name: SwitchName, env: Env = process.env) {
  return env[key(name)] !== "0"
}

// The `fork` block of opencode.json: each value fills its variable unless the environment already set it.
// Returns the names that are not fork flags, for the caller to report.
export function apply(values: Record<string, boolean | number | string> | undefined, env: Env = process.env) {
  return Object.entries(values ?? {}).flatMap(([given, value]) => {
    const name = given.toUpperCase().replace(/^OPENCODE_FORK_/, "")
    if (!(name in FLAGS)) return [given]
    env[`OPENCODE_FORK_${name}`] ??= value === true ? "1" : value === false ? "0" : String(value)
    return []
  })
}

export function raw(name: Name, env: Env = process.env) {
  return env[key(name)]
}

// Every flag with the value this process sees; `set` is false when the default applies.
export function describe(env: Env = process.env) {
  return Object.entries(FLAGS).map(([name, def]: [string, Def]) => {
    const value = env[`OPENCODE_FORK_${name}`]
    return { name: `OPENCODE_FORK_${name}`, kind: def.kind, value, set: value !== undefined, default: def.default, description: def.description }
  })
}
