export * as ForkSandboxTool from "./fork-sandbox"

import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { statSync } from "node:fs"
import os from "os"
import { ForkSandbox } from "@opencode-fork/core/sandbox"
import type { InstanceContext } from "../project/instance-context"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// Fork-owned glue for the bash tool's OS sandbox (see docs/fork/sandbox.md).

let usable: boolean | undefined
let warned = false

// bwrap can be installed yet unusable (user namespaces disabled), so try it once for real.
function bwrapUsable() {
  usable ??=
    Bun.which("bwrap") !== null &&
    Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--unshare-all", "true"], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0
  return usable
}

function stat(target: string) {
  const info = statSync(target, { throwIfNoEntry: false })
  if (!info) return undefined
  return info.isDirectory() ? "dir" : "file"
}

export function isEnabled(config: ConfigV1.Info) {
  return ForkSandbox.enabled(config.sandbox)
}

// The bwrap setup for this instance, or undefined when commands run unsandboxed
// (disabled, or enabled but bwrap is missing, which warns once).
export const resolve = Effect.fn("ForkSandbox.resolve")(function* (config: ConfigV1.Info, instance: InstanceContext) {
  if (!isEnabled(config)) return undefined
  if (!bwrapUsable()) {
    if (!warned) {
      warned = true
      yield* Effect.logWarning(ForkSandbox.UNAVAILABLE_WARNING)
      // The user believes bash is confined: say it where they look, not only in the log.
      const events = yield* Effect.serviceOption(EventV2Bridge.Service)
      if (events._tag === "Some")
        yield* events.value
          .publish(TuiEvent.ToastShow, {
            title: "Sandbox unavailable",
            message: ForkSandbox.UNAVAILABLE_WARNING,
            variant: "warning",
            duration: 15_000,
          })
          .pipe(Effect.ignore)
    }
    return undefined
  }
  return {
    networkOpen: ForkSandbox.networkOpen(config.sandbox),
    args: ForkSandbox.args({
      config: config.sandbox,
      home: os.homedir(),
      // A non-git project has worktree "/", which must never become writable.
      project: instance.worktree === "/" ? [instance.directory] : [instance.directory, instance.worktree],
      stat,
    }),
  }
})

export type Resolved = NonNullable<Effect.Success<ReturnType<typeof resolve>>>
