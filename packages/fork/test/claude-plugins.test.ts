import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ForkClaudePlugins } from "../src/claude-plugins"

// Fixtures reproduce the layout Claude Code writes under ~/.claude (installed_plugins.json v2,
// plugins/cache/<marketplace>/<plugin>/<version>/...).
let home: string
const env = {}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "fork-cc-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function write(file: string, content: string | object) {
  await Bun.write(file, typeof content === "string" ? content : JSON.stringify(content, null, 2))
}

function root(marketplace: string, name: string, version: string) {
  return path.join(home, ".claude", "plugins", "cache", marketplace, name, version)
}

async function install(
  entries: Record<string, { root: string; scope?: string; projectPath?: string; version?: string }[]>,
  enabledPlugins?: Record<string, boolean>,
) {
  await write(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(entries).map(([id, list]) => [
        id,
        list.map((item) => ({
          scope: item.scope ?? "user",
          installPath: item.root,
          version: item.version ?? "1.0.0",
          installedAt: "2026-04-05T00:46:42.828Z",
          lastUpdated: "2026-09-23T07:00:12.751Z",
          ...(item.projectPath ? { projectPath: item.projectPath } : {}),
        })),
      ]),
    ),
  })
  if (enabledPlugins) await write(path.join(home, ".claude", "settings.json"), { enabledPlugins })
}

const BRAINSTORMING = `---
name: brainstorming
description: "You MUST use this before any creative work - creating features."
---

# Brainstorming

Run \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh
`

async function superpowers() {
  const dir = root("claude-plugins-official", "superpowers", "6.4.1")
  await write(path.join(dir, ".claude-plugin", "plugin.json"), { name: "superpowers", version: "6.4.1" })
  await write(path.join(dir, "skills", "brainstorming", "SKILL.md"), BRAINSTORMING)
  await write(path.join(dir, "skills", "nested", "deep", "SKILL.md"), "---\ndescription: Deep: with colon\n---\nbody")
  return dir
}

test("skills are namespaced <plugin>:<skill> and expand the plugin root", async () => {
  const dir = await superpowers()
  await install({ "superpowers@claude-plugins-official": [{ root: dir, version: "6.4.1" }] })
  const result = await ForkClaudePlugins.skills({ home, env })
  expect(result.map((skill) => skill.name)).toEqual(["superpowers:brainstorming", "superpowers:deep"])
  const first = result[0]!
  expect(first.description).toStartWith("You MUST use this")
  expect(first.location).toBe(path.join(dir, "skills", "brainstorming", "SKILL.md"))
  expect(first.content).toContain(`Run ${dir}/scripts/x.sh`)
  // invalid YAML (unquoted colon) falls back to line parsing
  expect(result[1]!.description).toBe("Deep: with colon")
})

test("enabledPlugins in settings.json is respected", async () => {
  const dir = await superpowers()
  const other = root("local-skills", "ux-designer", "unknown")
  await write(path.join(other, "skills", "ux", "SKILL.md"), "---\nname: ux\ndescription: d\n---\nx")
  await install(
    { "superpowers@claude-plugins-official": [{ root: dir }], "ux-designer@local-skills": [{ root: other }] },
    { "superpowers@claude-plugins-official": true, "ux-designer@local-skills": false },
  )
  const names = (await ForkClaudePlugins.skills({ home, env })).map((skill) => skill.name)
  expect(names).toContain("superpowers:brainstorming")
  expect(names).not.toContain("ux-designer:ux")
})

test("without enabledPlugins every installed plugin is enabled", async () => {
  const dir = await superpowers()
  await install({ "superpowers@claude-plugins-official": [{ root: dir }] })
  expect(await ForkClaudePlugins.skills({ home, env })).toHaveLength(2)
  // no commands/ directory in this plugin
  expect(await ForkClaudePlugins.commands({ home, env })).toEqual({})
})

test("project scoped installs only apply inside their project", async () => {
  const dir = await superpowers()
  const project = path.join(home, "work", "app")
  await install({ "superpowers@claude-plugins-official": [{ root: dir, scope: "project", projectPath: project }] })
  expect(await ForkClaudePlugins.skills({ home, env, cwd: path.join(home, "elsewhere") })).toEqual([])
  expect(await ForkClaudePlugins.skills({ home, env, cwd: path.join(project, "src") })).toHaveLength(2)
})

test("OPENCODE_FORK_CC_PLUGINS=0 and a missing plugins directory do nothing", async () => {
  const dir = await superpowers()
  await install({ "superpowers@claude-plugins-official": [{ root: dir }] })
  expect(await ForkClaudePlugins.skills({ home, env: { OPENCODE_FORK_CC_PLUGINS: "0" } })).toEqual([])
  expect(await ForkClaudePlugins.skills({ home: path.join(home, "nothing"), env })).toEqual([])
})

test("tools translate to an opencode permission allowlist", () => {
  expect(ForkClaudePlugins.permission("Read, Grep, Glob, Write, WebFetch, Agent, Bogus")).toEqual({
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    edit: "allow",
    webfetch: "allow",
    task: "allow",
  })
  expect(ForkClaudePlugins.permission(["Bash(git *)", "Task", "mcp__notion__search", "mcp__github"])).toEqual({
    "*": "deny",
    bash: "allow",
    task: "allow",
    notion_search: "allow",
    "github_*": "allow",
  })
  expect(ForkClaudePlugins.permission(undefined)).toEqual({})
  expect(ForkClaudePlugins.permission(undefined, "Bash, Edit")).toEqual({ bash: "deny", edit: "deny" })
  expect(ForkClaudePlugins.permission("Read, Edit", "Edit")).toEqual({ "*": "deny", read: "allow", edit: "deny" })
  for (const [claude, opencode] of Object.entries({
    Read: "read",
    Edit: "edit",
    Write: "write",
    Bash: "bash",
    Grep: "grep",
    Glob: "glob",
    WebFetch: "webfetch",
    WebSearch: "websearch",
    TodoWrite: "todowrite",
    Agent: "task",
    Task: "task",
  })) {
    expect(ForkClaudePlugins.TOOLS[claude]).toBe(opencode)
  }
})

test("model aliases map to Anthropic models of an Anthropic provider, otherwise inherit", () => {
  expect(ForkClaudePlugins.model("sonnet")).toBe("anthropic/claude-sonnet-5-5")
  expect(ForkClaudePlugins.model("Opus", "anthropic/claude-haiku-4-5")).toBe("anthropic/claude-opus-5-5")
  expect(ForkClaudePlugins.model("haiku")).toBe("anthropic/claude-haiku-4-5")
  expect(ForkClaudePlugins.model("claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5")
  expect(ForkClaudePlugins.model("inherit")).toBeUndefined()
  expect(ForkClaudePlugins.model(undefined)).toBeUndefined()
  expect(ForkClaudePlugins.model("sonnet", "openai/gpt-5")).toBeUndefined()
})

test("agents become namespaced subagents", async () => {
  const dir = root("claude-plugins-official", "review-kit", "1.0.0")
  await write(
    path.join(dir, "agents", "code-reviewer.md"),
    `---
name: code-reviewer
description: Reviews code. Use after a change.
tools: Read, Grep, Glob, Bash
model: sonnet
color: blue
---

You are a reviewer. See \${CLAUDE_PLUGIN_ROOT}/rules.md
`,
  )
  await write(path.join(dir, "agents", "free.md"), "---\ndescription: Free\ntools:\n  - Read\nmodel: inherit\n---\nbody")
  await install({ "review-kit@claude-plugins-official": [{ root: dir }] })
  expect(await ForkClaudePlugins.agents({ home, env })).toEqual({
    "review-kit:code-reviewer": {
      description: "Reviews code. Use after a change.",
      mode: "subagent",
      prompt: `You are a reviewer. See ${dir}/rules.md`,
      model: "anthropic/claude-sonnet-5-5",
      permission: { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow", bash: "allow" },
    },
    "review-kit:free": {
      description: "Free",
      mode: "subagent",
      prompt: "body",
      permission: { "*": "deny", read: "allow" },
    },
  })
  expect(Object.keys((await ForkClaudePlugins.config({ home, env, model: "openai/x" })).agent)).toHaveLength(2)
})

test("commands are namespaced by plugin and subdirectory", async () => {
  const dir = root("claude-plugins-official", "notion", "0.1.0")
  await write(
    path.join(dir, "commands", "tasks", "build.md"),
    "---\ndescription: Build a task from a Notion page URL\nargs: task_url\n---\n\n# Build\n\nInput: $ARGUMENTS\nSee ${CLAUDE_PLUGIN_ROOT}/x\n",
  )
  await write(path.join(dir, "commands", "search.md"), "No frontmatter $1")
  await install({ "notion@claude-plugins-official": [{ root: dir, version: "0.1.0" }] })
  expect(await ForkClaudePlugins.commands({ home, env })).toEqual({
    "notion:tasks:build": {
      description: "Build a task from a Notion page URL",
      template: `# Build\n\nInput: $ARGUMENTS\nSee ${dir}/x`,
    },
    "notion:search": { description: undefined, template: "No frontmatter $1" },
  })
})
