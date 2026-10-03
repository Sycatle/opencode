export * as ForkClaudePlugins from "./claude-plugins"

import path from "node:path"
import { ForkHooks } from "./hooks"

// Reads Claude Code plugins installed under ~/.claude/plugins (read-only, except the helpers
// used by the `plugin-cc` CLI). Plugin skills, commands and agents are namespaced `<plugin>:<name>`.

export interface Options {
  home: string
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface Plugin {
  id: string
  name: string
  marketplace: string
  root: string
  version?: string
}

export interface Skill {
  name: string
  description?: string
  location: string
  content: string
}

// OPENCODE_FORK_CC_PLUGINS=0 turns everything off.
export function enabled(env: Record<string, string | undefined> = process.env) {
  return env.OPENCODE_FORK_CC_PLUGINS !== "0"
}

export function pluginsDir(home: string) {
  return path.join(home, ".claude", "plugins")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function readJson(file: string): Promise<unknown> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return undefined
  return handle.json().catch(() => undefined)
}

async function glob(pattern: string, cwd: string) {
  // A missing directory (plugin without commands/, agents/...) makes the scan throw.
  const files = await Array.fromAsync(
    new Bun.Glob(pattern).scan({ cwd, absolute: true, dot: true, followSymlinks: true }),
  ).catch(() => [])
  return files.filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`)).sort()
}

// `${CLAUDE_PLUGIN_ROOT}` (and the bare variable) point at the plugin's install directory.
export function expandRoot(text: string, root: string) {
  return text.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("$CLAUDE_PLUGIN_ROOT", root)
}

// Minimal frontmatter reader. Falls back to flat `key: value` lines when the YAML is invalid
// (Claude Code plugins often leave colons unquoted in descriptions).
export function frontmatter(text: string): { data: Record<string, unknown>; content: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/)
  if (!match) return { data: {}, content: text }
  const yaml = match[1] ?? ""
  const content = match[2] ?? ""
  const parsed = parseYaml(yaml)
  if (isRecord(parsed)) return { data: parsed, content }
  return {
    data: Object.fromEntries(
      yaml.split(/\r?\n/).flatMap((line) => {
        const pair = line.match(/^([\w-]+):\s*(.*)$/)
        if (!pair?.[1]) return []
        return [[pair[1], (pair[2] ?? "").replace(/^(["'])(.*)\1$/, "$2")]]
      }),
    ),
    content,
  }
}

function parseYaml(text: string): unknown {
  try {
    return Bun.YAML.parse(text)
  } catch {
    return undefined
  }
}

// settings.json `enabledPlugins` (user, then project, then project-local override each other).
// Undefined when no settings file declares the key: every installed plugin is then enabled.
async function enabledPlugins(opts: Options) {
  const files = [
    path.join(opts.home, ".claude", "settings.json"),
    ...(opts.cwd
      ? [path.join(opts.cwd, ".claude", "settings.json"), path.join(opts.cwd, ".claude", "settings.local.json")]
      : []),
  ]
  const found = (await Promise.all(files.map(readJson))).flatMap((data) =>
    isRecord(data) && isRecord(data.enabledPlugins) ? [data.enabledPlugins] : [],
  )
  if (found.length === 0) return undefined
  return Object.assign({}, ...found) as Record<string, unknown>
}

function within(dir: string, target: string) {
  const relative = path.relative(dir, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

// Installed and enabled plugins. Project and local scoped installs only apply inside their project.
export async function installed(opts: Options): Promise<Plugin[]> {
  if (!enabled(opts.env)) return []
  const data = await readJson(path.join(pluginsDir(opts.home), "installed_plugins.json"))
  if (!isRecord(data) || !isRecord(data.plugins)) return []
  const flags = await enabledPlugins(opts)
  return Object.entries(data.plugins).flatMap(([id, entries]) => {
    const at = id.lastIndexOf("@")
    if (at <= 0 || !Array.isArray(entries)) return []
    if (flags && flags[id] !== true) return []
    const candidates = entries.filter(isRecord).filter((entry) => {
      if (typeof entry.installPath !== "string") return false
      if (entry.scope !== "project" && entry.scope !== "local") return true
      return typeof entry.projectPath === "string" && opts.cwd !== undefined && within(entry.projectPath, opts.cwd)
    })
    const entry = candidates.find((item) => item.scope === "project" || item.scope === "local") ?? candidates[0]
    if (!entry || typeof entry.installPath !== "string") return []
    return [
      {
        id,
        name: id.slice(0, at),
        marketplace: id.slice(at + 1),
        root: entry.installPath,
        version: typeof entry.version === "string" ? entry.version : undefined,
      },
    ]
  })
}

// `skills/**/SKILL.md` of every enabled plugin, named `<plugin>:<skill>`.
export async function skills(opts: Options): Promise<Skill[]> {
  const plugins = await installed(opts)
  return (
    await Promise.all(
      plugins.map(async (plugin) =>
        Promise.all(
          (await glob("skills/**/SKILL.md", plugin.root)).map(async (file) => {
            const md = frontmatter(await Bun.file(file).text())
            const name = typeof md.data.name === "string" ? md.data.name : path.basename(path.dirname(file))
            return {
              name: `${plugin.name}:${name}`,
              description: typeof md.data.description === "string" ? md.data.description : undefined,
              location: file,
              content: expandRoot(md.content, plugin.root),
            }
          }),
        ),
      ),
    )
  ).flat()
}

export interface Command {
  description?: string
  template: string
}

// `commands/**/*.md` become slash commands named `<plugin>:<path>` (`tasks/build.md` -> `notion:tasks:build`).
// `$ARGUMENTS` and `$1` placeholders are shared by both tools.
export async function commands(opts: Options): Promise<Record<string, Command>> {
  const plugins = await installed(opts)
  const entries = await Promise.all(
    plugins.map(async (plugin) => {
      const dir = path.join(plugin.root, "commands")
      return Promise.all(
        (await glob("**/*.md", dir)).map(async (file) => {
          const md = frontmatter(await Bun.file(file).text())
          const relative = path.relative(dir, file).slice(0, -".md".length).split(path.sep).join(":")
          return [
            `${plugin.name}:${relative}`,
            {
              description: typeof md.data.description === "string" ? md.data.description : undefined,
              template: expandRoot(md.content.trim(), plugin.root),
            },
          ] as const
        }),
      )
    }),
  )
  return Object.fromEntries(entries.flat())
}

// Claude Code tool name -> opencode tool name.
export const TOOLS: Record<string, string> = {
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  LS: "list",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  Agent: "task",
  Task: "task",
  Skill: "skill",
}

// Claude Code model alias -> Anthropic model id.
export const MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-4-5",
}

// `inherit`, no model, or a provider other than Anthropic keep the parent's model.
// `current` is the configured `provider/model`.
export function model(value: unknown, current?: string) {
  if (typeof value !== "string") return undefined
  const provider = current?.includes("/") ? current.slice(0, current.indexOf("/")) : "anthropic"
  if (provider !== "anthropic") return undefined
  const alias = value.trim().toLowerCase().replace(/\[.*\]$/, "")
  const id = MODELS[alias] ?? (alias.startsWith("claude-") ? alias : undefined)
  return id ? `anthropic/${id}` : undefined
}

// opencode permission keys for a Claude Code `tools` entry (`Bash(git *)`, `mcp__server__tool`...).
// Writes are governed by the `edit` permission; unknown tools map to nothing.
function permissionKeys(entry: string) {
  const name = entry.replace(/\(.*\)$/, "").trim()
  const mcp = name.match(/^mcp__([^_].*?)(?:__(.+))?$/)
  if (mcp?.[1]) return [`${mcp[1]}_${mcp[2] ?? "*"}`]
  const tool = TOOLS[name]
  if (!tool) return []
  if (tool === "write") return ["edit"]
  if (tool === "glob") return ["glob", "list"]
  return [tool]
}

function list(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value !== "string") return undefined
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

// An explicit `tools` list is an allowlist: everything else is denied. `disallowedTools` denies on top.
// Without either, the agent keeps the default permissions.
export function permission(tools: unknown, disallowed?: unknown) {
  const allow = list(tools)?.flatMap(permissionKeys)
  const deny = list(disallowed)?.flatMap(permissionKeys) ?? []
  return {
    ...(allow ? { "*": "deny" } : {}),
    ...Object.fromEntries((allow ?? []).map((key) => [key, "allow"])),
    ...Object.fromEntries(deny.map((key) => [key, "deny"])),
  } as Record<string, "allow" | "deny">
}

export interface Agent {
  description?: string
  mode: "subagent"
  prompt: string
  model?: string
  permission?: Record<string, "allow" | "deny">
}

// `agents/**/*.md` become subagents named `<plugin>:<name>`.
export async function agents(opts: Options & { model?: string }): Promise<Record<string, Agent>> {
  const plugins = await installed(opts)
  const entries = await Promise.all(
    plugins.map(async (plugin) =>
      Promise.all(
        (await glob("agents/**/*.md", plugin.root)).map(async (file) => {
          const md = frontmatter(await Bun.file(file).text())
          const name = typeof md.data.name === "string" ? md.data.name : path.basename(file, ".md")
          const perms = permission(md.data.tools, md.data.disallowedTools)
          const selected = model(md.data.model, opts.model)
          return [
            `${plugin.name}:${name}`,
            {
              description: typeof md.data.description === "string" ? md.data.description : undefined,
              mode: "subagent",
              prompt: expandRoot(md.content.trim(), plugin.root),
              ...(selected ? { model: selected } : {}),
              ...(Object.keys(perms).length > 0 ? { permission: perms } : {}),
            },
          ] as const
        }),
      ),
    ),
  )
  return Object.fromEntries(entries.flat())
}

export type Mcp =
  | { type: "local"; command: string[]; environment?: Record<string, string> }
  | { type: "remote"; url: string; headers?: Record<string, string> }

// `${CLAUDE_PLUGIN_ROOT}` is expanded, `${VAR}` and `${VAR:-default}` are resolved now (injected
// config is not run through opencode's `{env:VAR}` substitution).
function expandValue(text: string, root: string, env: Record<string, string | undefined>) {
  return expandRoot(text, root).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    return env[name] ?? fallback ?? ""
  })
}

function strings(value: unknown, root: string, env: Record<string, string | undefined>) {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === "string" ? [[key, expandValue(item, root, env)]] : [])),
  )
}

// Converts the content of a plugin `.mcp.json` (either `{ mcpServers: {...} }` or the bare map)
// into opencode MCP entries, keyed by server name. Unusable entries are dropped.
export function mcpServers(input: unknown, root: string, env: Record<string, string | undefined> = process.env) {
  const servers = isRecord(input) && isRecord(input.mcpServers) ? input.mcpServers : input
  if (!isRecord(servers)) return {}
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, server]): [string, Mcp][] => {
      if (!isRecord(server)) return []
      if (typeof server.url === "string") {
        const headers = strings(server.headers, root, env)
        return [[name, { type: "remote", url: expandValue(server.url, root, env), ...(headers ? { headers } : {}) }]]
      }
      if (typeof server.command !== "string") return []
      const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : []
      const environment = strings(server.env, root, env)
      return [
        [
          name,
          {
            type: "local",
            command: [server.command, ...args].map((part) => expandValue(part, root, env)),
            ...(environment ? { environment } : {}),
          },
        ],
      ]
    }),
  )
}

// MCP servers of enabled plugins from `.mcp.json` and an inline `mcpServers` in plugin.json.
// A server named like its plugin keeps that name; others are `<plugin>-<server>`.
export async function mcp(opts: Options): Promise<Record<string, Mcp>> {
  const plugins = await installed(opts)
  const env = opts.env ?? process.env
  const entries = await Promise.all(
    plugins.map(async (plugin) => {
      const manifest = await readJson(path.join(plugin.root, ".claude-plugin", "plugin.json"))
      const files = await readJson(path.join(plugin.root, ".mcp.json"))
      const inline = isRecord(manifest) && isRecord(manifest.mcpServers) ? manifest.mcpServers : {}
      return Object.entries({
        ...mcpServers(inline, plugin.root, env),
        ...mcpServers(files, plugin.root, env),
      }).map(([name, server]) => [name === plugin.name ? name : `${plugin.name}-${name}`, server] as const)
    }),
  )
  return Object.fromEntries(entries.flat())
}

// Events whose matcher does not select a tool name in the fork. Claude Code matchers on these
// (e.g. SessionStart `startup|clear|compact`) filter on other values, so they are dropped.
const UNMATCHED_EVENTS = ["UserPromptSubmit", "SessionStart", "Stop", "PreCompact"]

// Converts the content of a plugin `hooks/hooks.json` (`{ hooks: { Event: [{ matcher, hooks: [{ type,
// command, timeout }] }] } }`, timeout in seconds) into the fork `hooks` config key. Only `command`
// hooks of events the fork supports survive; `${CLAUDE_PLUGIN_ROOT}` is expanded.
export function hooks(input: unknown, root: string): ForkHooks.Hooks {
  const events = isRecord(input) && isRecord(input.hooks) ? input.hooks : input
  if (!isRecord(events)) return {}
  return ForkHooks.parse(
    Object.fromEntries(
      Object.entries(events).map(([event, groups]) => [
        event,
        (Array.isArray(groups) ? groups : []).filter(isRecord).flatMap((group) =>
          (Array.isArray(group.hooks) ? group.hooks : []).filter(isRecord).flatMap((hook) => {
            if (hook.type !== "command" || typeof hook.command !== "string") return []
            return [
              {
                command: expandRoot(hook.command, root),
                ...(typeof group.matcher === "string" && !UNMATCHED_EVENTS.includes(event)
                  ? { matcher: group.matcher }
                  : {}),
                ...(typeof hook.timeout === "number" && hook.timeout > 0 ? { timeout: hook.timeout * 1000 } : {}),
              },
            ]
          }),
        ),
      ]),
    ),
  )
}

// Hooks of every enabled plugin, concatenated per event. Not wired into the config yet.
export async function pluginHooks(opts: Options): Promise<ForkHooks.Hooks> {
  const plugins = await installed(opts)
  const all = await Promise.all(
    plugins.map(async (plugin) => hooks(await readJson(path.join(plugin.root, "hooks", "hooks.json")), plugin.root)),
  )
  return all.reduce<ForkHooks.Hooks>(
    (merged, next) => ({
      ...merged,
      ...Object.fromEntries(
        Object.entries(next).map(([event, entries]) => [
          event,
          [...(merged[event as ForkHooks.Event] ?? []), ...entries],
        ]),
      ),
    }),
    {},
  )
}

export interface Config {
  command: Record<string, Command>
  agent: Record<string, Agent>
  mcp: Record<string, Mcp>
}

// Everything a plugin contributes to the opencode config. Callers merge it below the user's own
// config so that explicit settings always win. `model` is the configured `provider/model`, used
// to translate agent model aliases.
export async function config(opts: Options & { model?: string }): Promise<Config> {
  const [command, agent, servers] = await Promise.all([commands(opts), agents(opts), mcp(opts)])
  return { command, agent, mcp: servers }
}
