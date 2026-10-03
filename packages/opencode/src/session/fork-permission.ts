import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import { Permission } from "@/permission"
import type { Plugin } from "@/plugin"

type AskInput = Parameters<Permission.Interface["ask"]>[0]

// Gives plugins (`permission.ask`) a chance to settle a permission before the user is prompted:
// "allow" skips the permission service, "deny" fails it, "ask" keeps the normal flow. Requests the
// ruleset already settles never reach plugins, so a hook can never turn a config/agent/session deny into
// an allow, nor an allow into an ask. "Always" approvals live inside the Permission service and are not
// visible here: a request they would settle may still reach plugins, which can only allow, deny or leave it.
export const askWithPlugins = Effect.fn("ForkPermission.ask")(function* (
  plugin: Plugin.Interface,
  permission: Permission.Interface,
  input: AskInput,
) {
  const rules = input.patterns.map((pattern) => Permission.evaluate(input.permission, pattern, input.ruleset))
  if (rules.every((rule) => rule.action === "allow") || rules.some((rule) => rule.action === "deny"))
    return yield* permission.ask(input)

  const result = yield* plugin.trigger(
    "permission.ask",
    {
      id: input.id ?? "",
      type: input.permission,
      pattern: input.patterns,
      sessionID: input.sessionID,
      messageID: input.tool?.messageID ?? "",
      callID: input.tool?.callID,
      title: input.permission,
      metadata: input.metadata,
      time: { created: Date.now() },
    },
    { status: "ask" as "ask" | "deny" | "allow" },
  )
  if (result.status === "allow") return
  if (result.status === "deny")
    return yield* new PermissionV1.DeniedError({
      ruleset: input.ruleset.filter((rule) => rule.permission === input.permission),
    })
  return yield* permission.ask(input)
})
