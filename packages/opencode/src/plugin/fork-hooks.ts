import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Event as EventV2 } from "@opencode-ai/sdk/v2"
import { ForkHooks } from "@opencode-fork/core/hooks"
import { PartID } from "@/session/schema"
import { smallModelAsk } from "./fork-hooks-model"

// Declarative `hooks` from opencode.json: shell commands, HTTP posts and small-model prompts (see ForkHooks for the contract).
export function ForkHooksPlugin(input: PluginInput) {
  return createForkHooksPlugin(input)
}

// `deps.ask` replaces the small-model call (tests inject it).
export async function createForkHooksPlugin(input: PluginInput, deps: ForkHooks.Deps = {}): Promise<Hooks> {
  let hooks: ForkHooks.Hooks = {}
  // Model of each session's last user message: prompt hooks run on that provider's small model.
  const models = new Map<string, { providerID: string; modelID: string }>()
  const ask = deps.ask ?? smallModelAsk(input.directory, (sessionID) => (sessionID ? models.get(sessionID) : undefined))
  // Sessions seen by this instance: parent (for SubagentStop vs Stop), agent, and liveness (for SessionEnd on exit).
  const parents = new Map<string, string | undefined>()
  const agents = new Map<string, string>()
  const live = new Set<string>()
  // Tool calls a PreToolUse hook blocked: not a tool failure.
  const blockedCalls = new Set<string>()

  const fire = async (
    event: ForkHooks.Event,
    payload: Omit<ForkHooks.Payload, "event" | "cwd">,
    name?: string,
  ): Promise<ForkHooks.Outcome> => {
    if (!ForkHooks.enabled()) return {}
    const entries = ForkHooks.select(hooks, event, name)
    if (!entries.length) return {}
    return ForkHooks.runAll(
      entries,
      { ...payload, event, cwd: input.directory },
      (entry, error) => {
        void input.client.app
          .log({
            body: { service: "fork-hooks", level: "warn", message: `${event} hook "${ForkHooks.describe(entry)}": ${error}` },
          })
          .catch(() => undefined)
      },
      { ask },
    )
  }

  return {
    config: async (config) => {
      hooks = ForkHooks.parse((config as { hooks?: unknown }).hooks)
    },

    // The plugin Event type predates permission.asked and question.asked: narrow with the v2 events the bus really emits.
    event: async (received) => {
      const event = received.event as unknown as EventV2
      if (event.type === "session.created") {
        const info = event.properties.info
        parents.set(info.id, info.parentID)
        live.add(info.id)
        await fire("SessionStart", { sessionID: info.id, parentID: info.parentID })
        return
      }
      if (event.type === "message.updated") {
        live.add(event.properties.info.sessionID)
        agents.set(event.properties.info.sessionID, event.properties.info.agent)
        if (event.properties.info.role === "user") models.set(event.properties.info.sessionID, event.properties.info.model)
        return
      }
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        const parentID = parents.get(sessionID)
        // A child session going idle is a finished subagent task (foreground or background).
        if (parentID) {
          await fire("SubagentStop", { sessionID, parentID, agent: agents.get(sessionID) })
          return
        }
        await Promise.all([
          fire("Stop", { sessionID }),
          fire(
            "Notification",
            { sessionID, notificationType: "idle", message: "Session is idle and waiting for input" },
            "idle",
          ),
        ])
        return
      }
      if (event.type === "permission.asked") {
        const request = event.properties
        await fire(
          "Notification",
          {
            sessionID: request.sessionID,
            notificationType: "permission",
            message: `Permission requested: ${request.permission} ${request.patterns.join(" ")}`.trim(),
          },
          "permission",
        )
        return
      }
      if (event.type === "question.asked") {
        await fire(
          "Notification",
          {
            sessionID: event.properties.sessionID,
            notificationType: "question",
            message: event.properties.questions[0]?.question ?? "A question is waiting for an answer",
          },
          "question",
        )
        return
      }
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        parents.delete(sessionID)
        agents.delete(sessionID)
        models.delete(sessionID)
        live.delete(sessionID)
        await fire("SessionEnd", { sessionID, parentID: event.properties.info.parentID, reason: "deleted" })
      }
    },

    // The instance is going away (process exit or reload): every session still alive ends here.
    dispose: async () => {
      const ids = [...live]
      live.clear()
      await Promise.all(ids.map((sessionID) => fire("SessionEnd", { sessionID, parentID: parents.get(sessionID), reason: "exit" })))
    },

    "tool.execute.before": async (info, output) => {
      const outcome = await fire(
        "PreToolUse",
        { sessionID: info.sessionID, tool: info.tool, args: output.args },
        info.tool,
      )
      if (ForkHooks.blocked(outcome)) {
        blockedCalls.add(info.callID)
        throw new Error(outcome.reason || "Blocked by PreToolUse hook")
      }
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

    "tool.execute.failure": async (info, output) => {
      if (blockedCalls.delete(info.callID)) return
      const outcome = await fire(
        "PostToolUseFailure",
        { sessionID: info.sessionID, tool: info.tool, args: info.args, error: output.error },
        info.tool,
      )
      if (outcome.additionalContext) output.error = `${output.error}\n\n${outcome.additionalContext}`
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
