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
  await write(
    path.join(dir, "agents", "free.md"),
    "---\ndescription: Free\ntools:\n  - Read\nmodel: inherit\n---\nbody",
  )
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

test("mcp servers convert both .mcp.json shapes and expand the plugin root", async () => {
  const context7 = root("claude-plugins-official", "context7", "d182ca456ca0")
  await write(path.join(context7, ".mcp.json"), {
    mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp?client=claude-code-plugin" } },
  })
  const playwright = root("claude-plugins-official", "playwright", "d182ca456ca0")
  await write(path.join(playwright, ".mcp.json"), {
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    local: {
      command: "${CLAUDE_PLUGIN_ROOT}/bin/serve",
      args: ["--token", "${TOKEN}", "--mode=${MODE:-fast}"],
      env: { ROOT: "${CLAUDE_PLUGIN_ROOT}" },
    },
    bad: { nothing: true },
  })
  await install({
    "context7@claude-plugins-official": [{ root: context7 }],
    "playwright@claude-plugins-official": [{ root: playwright }],
  })
  expect(await ForkClaudePlugins.mcp({ home, env: { TOKEN: "abc" } })).toEqual({
    context7: { type: "remote", url: "https://mcp.context7.com/mcp?client=claude-code-plugin" },
    playwright: { type: "local", command: ["npx", "@playwright/mcp@latest"] },
    "playwright-local": {
      type: "local",
      command: [`${playwright}/bin/serve`, "--token", "abc", "--mode=fast"],
      environment: { ROOT: playwright },
    },
  })
})

test("hooks.json converts to the fork hooks key", async () => {
  const dir = root("claude-plugins-official", "superpowers", "6.4.1")
  const file = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|clear|compact",
          hooks: [
            {
              type: "command",
              command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
              shell: "bash",
              async: false,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash|Edit",
          hooks: [
            { type: "command", command: "$CLAUDE_PLUGIN_ROOT/guard.sh", timeout: 5 },
            { type: "prompt", prompt: "ignored" },
          ],
        },
      ],
      SubagentStop: [{ hooks: [{ type: "command", command: "unsupported" }] }],
      Stop: "malformed",
    },
  }
  expect(ForkClaudePlugins.hooks(file, dir)).toEqual({
    SessionStart: [{ type: "command", command: `"${dir}/hooks/run-hook.cmd" session-start` }],
    PreToolUse: [{ type: "command", matcher: "Bash|Edit", command: `${dir}/guard.sh`, timeout: 5000 }],
    SubagentStop: [{ type: "command", command: "unsupported" }],
  })
  expect(ForkClaudePlugins.hooks(undefined, dir)).toEqual({})

  await write(path.join(dir, "hooks", "hooks.json"), file)
  await install({ "superpowers@claude-plugins-official": [{ root: dir }] })
  const merged = await ForkClaudePlugins.pluginHooks({ home, env })
  expect(Object.keys(merged).sort()).toEqual(["PreToolUse", "SessionStart", "SubagentStop"])
})

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn({
    cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return out.trim()
}

// A git repository holding a marketplace with a relative plugin and a plugin cloned from another repo.
async function marketplaceRepo() {
  const external = path.join(home, "external-plugin")
  await write(path.join(external, ".claude-plugin", "plugin.json"), { name: "ext", version: "2.1.0" })
  await write(path.join(external, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: hi\n---\nhello")
  await git(home, "init", "-q", external)
  await git(external, "add", "-A")
  await git(external, "commit", "-q", "-m", "init")

  const repo = path.join(home, "market")
  await write(path.join(repo, ".claude-plugin", "marketplace.json"), {
    name: "mkt",
    owner: { name: "me" },
    plugins: [
      { name: "local", source: "./plugins/local" },
      { name: "ext", source: { source: "url", url: `file://${external}` } },
    ],
  })
  await write(path.join(repo, "plugins", "local", ".claude-plugin", "plugin.json"), { name: "local", version: "0.3.0" })
  await write(path.join(repo, "plugins", "local", "commands", "go.md"), "---\ndescription: go\n---\ngo")
  await git(home, "init", "-q", repo)
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "init")
  return { repo, external, sha: await git(external, "rev-parse", "HEAD") }
}

test("marketplace add, add, list and rm write the files Claude Code reads", async () => {
  const { repo, sha } = await marketplaceRepo()
  await write(path.join(home, ".claude", "settings.json"), { theme: "dark", enabledPlugins: { "other@x": true } })
  const manage = { home, github: () => `file://${repo}` }

  // directory source is referenced in place
  expect(await ForkClaudePlugins.marketplaceAdd(manage, repo)).toEqual({ name: "mkt", installLocation: repo })
  const known = (await Bun.file(path.join(home, ".claude", "plugins", "known_marketplaces.json")).json()) as any
  expect(known.mkt.source).toEqual({ source: "directory", path: repo })

  const local = await ForkClaudePlugins.add(manage, "local@mkt")
  expect(local.version).toBe("0.3.0")
  expect(local.installPath).toBe(root("mkt", "local", "0.3.0"))
  expect(await Bun.file(path.join(local.installPath, "commands", "go.md")).exists()).toBe(true)
  expect(await Bun.file(path.join(local.installPath, ".git")).exists()).toBe(false)

  const ext = await ForkClaudePlugins.add(manage, "ext@mkt")
  expect(ext.version).toBe("2.1.0")
  const installedFile = (await Bun.file(path.join(home, ".claude", "plugins", "installed_plugins.json")).json()) as any
  expect(installedFile.version).toBe(2)
  expect(installedFile.plugins["ext@mkt"][0]).toMatchObject({ scope: "user", version: "2.1.0", gitCommitSha: sha })
  const settings = (await Bun.file(path.join(home, ".claude", "settings.json")).json()) as any
  expect(settings).toEqual({
    theme: "dark",
    enabledPlugins: { "other@x": true, "local@mkt": true, "ext@mkt": true },
  })

  // what Claude Code wrote is what opencode reads, and the other way round
  expect((await ForkClaudePlugins.skills({ home, env })).map((skill) => skill.name)).toEqual(["ext:hello"])
  expect(Object.keys(await ForkClaudePlugins.commands({ home, env }))).toEqual(["local:go"])
  expect((await ForkClaudePlugins.all({ home })).map((plugin) => [plugin.id, plugin.enabled])).toEqual([
    ["local@mkt", true],
    ["ext@mkt", true],
  ])

  await ForkClaudePlugins.remove(manage, "local@mkt")
  expect(await Bun.file(path.join(local.installPath, "commands", "go.md")).exists()).toBe(false)
  expect((await ForkClaudePlugins.all({ home })).map((plugin) => plugin.id)).toEqual(["ext@mkt"])
  expect(((await Bun.file(path.join(home, ".claude", "settings.json")).json()) as any).enabledPlugins).toEqual({
    "other@x": true,
    "ext@mkt": true,
  })
  await expect(ForkClaudePlugins.remove(manage, "local@mkt")).rejects.toThrow("not installed")
})

test("marketplace add clones a GitHub repository under plugins/marketplaces", async () => {
  const { repo } = await marketplaceRepo()
  const manage = { home, github: () => `file://${repo}` }
  const result = await ForkClaudePlugins.marketplaceAdd(manage, "owner/market")
  const location = path.join(home, ".claude", "plugins", "marketplaces", "mkt")
  expect(result).toEqual({ name: "mkt", installLocation: location })
  const known = (await Bun.file(path.join(home, ".claude", "plugins", "known_marketplaces.json")).json()) as any
  expect(known.mkt.source).toEqual({ source: "github", repo: "owner/market" })
  expect((await ForkClaudePlugins.add(manage, "local@mkt")).version).toBe("0.3.0")
  await expect(ForkClaudePlugins.marketplaceAdd(manage, "nonsense")).rejects.toThrow("neither a directory")
  await expect(ForkClaudePlugins.add(manage, "missing@mkt")).rejects.toThrow("not found")
  await expect(ForkClaudePlugins.add(manage, "local@unknown")).rejects.toThrow("unknown marketplace")
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
