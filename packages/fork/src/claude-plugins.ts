export * as ForkClaudePlugins from "./claude-plugins"

import path from "node:path"

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
  const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd, absolute: true, dot: true, followSymlinks: true }))
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
