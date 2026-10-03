import type { ForkHooks } from "@opencode-fork/core/hooks"

// One-shot completion on the small model of the session's provider, for `type: "prompt"` hooks.
// The plugin has no Effect services, so it goes through AppRuntime scoped to the project directory
// (same model resolution as the title and project-copy-name generators, see session/fork-small-model.ts).
export function smallModelAsk(
  directory: string,
  session: (sessionID: string | undefined) => { providerID: string; modelID: string } | undefined,
): ForkHooks.Ask {
  return async (prompt, event) => {
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { InstanceStore } = await import("@/project/instance-store")
    const { smallModelRun } = await import("@/session/fork-small-model")

    const current = session(event.sessionID)
    const result = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) => store.provide({ directory }, smallModelRun({ prompt, current }))),
    )
    return result.text
  }
}
