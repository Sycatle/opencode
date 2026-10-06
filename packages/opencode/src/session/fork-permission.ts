import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ForkClassifier } from "@opencode-fork/core/classifier"
import { Effect } from "effect"
import { Permission } from "@/permission"
import type { Plugin } from "@/plugin"
import { InstanceRef } from "@/effect/instance-ref"
import type { Judgement } from "./fork-classify"

type AskInput = Parameters<Permission.Interface["ask"]>[0]

// Gives plugins (`permission.ask`) a chance to settle a permission before the user is prompted:
// "allow" skips the permission service, "deny" fails it, "ask" keeps the normal flow. Requests the
// ruleset already settles never reach plugins, so a hook can never turn a config/agent/session deny into
// an allow, nor an allow into an ask. "Always" approvals live inside the Permission service and are not
// visible here: a request they would settle may still reach plugins, which can only allow, deny or leave it.
//
// What is still "ask" then goes through the session's permission mode (ForkClassifier). Auto approves without
// user interaction; Build keeps the normal permission prompt.
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

  if (ForkClassifier.storedMode(input.ruleset) === "auto") return
  const instance = yield* InstanceRef
  if (!instance) return yield* permission.ask(input)
  // The judge needs Session, LLM and Provider: run it in the project's instance rather than widening this
  // effect's requirements at every call site (same route as the prompt-hook model).
  const judgement = yield* Effect.promise(async (): Promise<Judgement> => {
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { InstanceStore } = await import("@/project/instance-store")
    const { judge } = await import("./fork-classify")
    return AppRuntime.runPromise(
      InstanceStore.Service.use((store) => store.provide({ directory: instance.directory }, judge(input))),
    )
  })
  if (judgement.action === "allow") return
  return yield* permission.ask(
    judgement.reason
      ? { ...input, metadata: { ...input.metadata, [ForkClassifier.REASON_KEY]: judgement.reason } }
      : input,
  )
})
