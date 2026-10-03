import { Global } from "@opencode-ai/core/global"
import { ForkClaudePlugins } from "@opencode-fork/core/claude-plugins"
import { cmd } from "./cmd"

// Runs a management action and turns its error into a message and a non-zero exit code.
const run = (action: () => Promise<void>) =>
  action().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

const AddCommand = cmd({
  command: "add <plugin>",
  describe: "install a plugin from a marketplace (<plugin>@<marketplace>), shared with Claude Code",
  builder: (yargs) => yargs.positional("plugin", { type: "string", demandOption: true }),
  handler: (args) =>
    run(async () => {
      const result = await ForkClaudePlugins.add({ home: Global.Path.home }, args.plugin)
      console.log(`Installed ${result.id} ${result.version} in ${result.installPath}`)
      if (!result.flagged) console.log("settings.json is not valid JSON: enable the plugin there by hand.")
    }),
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list installed Claude Code plugins",
  handler: () =>
    run(async () => {
      const plugins = await ForkClaudePlugins.all({ home: Global.Path.home, cwd: process.cwd() })
      if (plugins.length === 0) return console.log("No Claude Code plugins installed.")
      plugins.forEach((plugin) =>
        console.log(
          `${plugin.id}  ${plugin.version ?? "unknown"}  ${plugin.scope}  ${plugin.enabled ? "enabled" : "disabled"}`,
        ),
      )
    }),
})

const RemoveCommand = cmd({
  command: "rm <plugin>",
  aliases: ["remove"],
  describe: "uninstall a plugin (<plugin>@<marketplace>)",
  builder: (yargs) => yargs.positional("plugin", { type: "string", demandOption: true }),
  handler: (args) =>
    run(async () => {
      await ForkClaudePlugins.remove({ home: Global.Path.home }, args.plugin)
      console.log(`Removed ${args.plugin}`)
    }),
})

const MarketplaceAddCommand = cmd({
  command: "add <source>",
  describe: "register a marketplace from a GitHub repository (owner/repo) or a local path",
  builder: (yargs) => yargs.positional("source", { type: "string", demandOption: true }),
  handler: (args) =>
    run(async () => {
      const result = await ForkClaudePlugins.marketplaceAdd({ home: Global.Path.home }, args.source)
      console.log(`Marketplace ${result.name} registered at ${result.installLocation}`)
    }),
})

const MarketplaceCommand = cmd({
  command: "marketplace",
  describe: "manage plugin marketplaces",
  builder: (yargs) => yargs.command(MarketplaceAddCommand).demandCommand(),
  handler: () => {},
})

// Reads and writes the same ~/.claude/plugins files as Claude Code, so a plugin installed on one side is seen by the other.
export const PluginCcCommand = cmd({
  command: "plugin-cc",
  describe: "manage Claude Code plugins (skills, commands, agents, MCP servers) shared with ~/.claude/plugins",
  builder: (yargs) =>
    yargs.command(AddCommand).command(ListCommand).command(RemoveCommand).command(MarketplaceCommand).demandCommand(),
  handler: () => {},
})
