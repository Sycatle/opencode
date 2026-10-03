import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { ForkHooks } from "@opencode-fork/core/hooks"
import { PartID } from "@/session/schema"

// Declarative `hooks` from opencode.json, run as shell commands (see ForkHooks for the contract).
export async function ForkHooksPlugin(input: PluginInput): Promise<Hooks> {
  let hooks: ForkHooks.Hooks = {}

  const fire = async (
    event: ForkHooks.Event,
    payload: Omit<ForkHooks.Payload, "event" | "cwd">,
    name?: string,
  ): Promise<ForkHooks.Outcome> => {
    if (!ForkHooks.enabled()) return {}
    const entries = ForkHooks.select(hooks, event, name)
    if (!entries.length) return {}
    return ForkHooks.runAll(entries, { ...payload, event, cwd: input.directory }, (entry, error) => {
      void input.client.app
        .log({ body: { service: "fork-hooks", level: "warn", message: `${event} hook "${entry.command}": ${error}` } })
        .catch(() => undefined)
    })
  }

  return {
    config: async (config) => {
      hooks = ForkHooks.parse((config as { hooks?: unknown }).hooks)
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        await fire("SessionStart", { sessionID: event.properties.info.id })
        return
      }
      if (event.type === "session.idle") await fire("Stop", { sessionID: event.properties.sessionID })
    },

    "tool.execute.before": async (info, output) => {
      const outcome = await fire(
        "PreToolUse",
        { sessionID: info.sessionID, tool: info.tool, args: output.args },
        info.tool,
      )
      if (ForkHooks.blocked(outcome)) throw new Error(outcome.reason || "Blocked by PreToolUse hook")
      if (!outcome.args) return
      // Callers keep a reference to the original args object, so replace its contents in place.
      Object.keys(output.args).forEach((key) => delete output.args[key])
      Object.assign(output.args, outcome.args)
    },

    "tool.execute.after": async (info, output) => {
      // A failed or cancelled subtask triggers this hook without any output.
      if (!output) return
      const outcome = await fire(
        "PostToolUse",
        { sessionID: info.sessionID, tool: info.tool, args: info.args, output: output.output },
        info.tool,
      )
      if (outcome.additionalContext) output.output = `${output.output}\n\n${outcome.additionalContext}`
    },

    "chat.message": async (info, output) => {
      const prompt = output.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n")
      const outcome = await fire("UserPromptSubmit", { sessionID: info.sessionID, prompt })
      if (ForkHooks.blocked(outcome)) {
        // Signalled in-band: the prompt seam turns this part into a session error before anything is persisted.
        output.parts.splice(0, output.parts.length, {
          id: PartID.ascending(),
          sessionID: output.message.sessionID,
          messageID: output.message.id,
          type: "text",
          text: outcome.reason || "Prompt blocked by UserPromptSubmit hook",
          synthetic: true,
          metadata: { [ForkHooks.PROMPT_BLOCK_KEY]: true },
        })
        return
      }
      if (!outcome.additionalContext) return
      output.parts.push({
        id: PartID.ascending(),
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        type: "text",
        text: outcome.additionalContext,
        synthetic: true,
      })
    },

    "experimental.session.compacting": async (info, output) => {
      const outcome = await fire("PreCompact", { sessionID: info.sessionID })
      if (outcome.additionalContext) output.context.push(outcome.additionalContext)
    },

    "permission.ask": async (info, output) => {
      const outcome = await fire(
        "PermissionRequest",
        { sessionID: info.sessionID, permission: { type: info.type, pattern: info.pattern, metadata: info.metadata } },
        info.type,
      )
      if (!outcome.decision) return
      output.status = outcome.decision === "block" ? "deny" : outcome.decision
    },
  }
}
