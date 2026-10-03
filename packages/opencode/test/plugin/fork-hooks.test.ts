import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin/index"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { askWithPlugins } from "../../src/session/fork-permission"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Plugin.node, Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [Auth.node, AuthTest.empty],
      [Account.node, AccountTest.empty],
      [Npm.node, NpmTest.noop],
      [RuntimeFlags.node, RuntimeFlags.layer({})],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ],
  ),
)

function withHooks<A, E, R>(hooks: unknown, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", hooks }),
      ),
    )
    return yield* self
  })
}

const json = (value: unknown) => `cat > /dev/null; echo '${JSON.stringify(value)}'`
const guard = 'if grep -q "rm -rf"; then echo "destructive command" >&2; exit 2; fi'
const before = { tool: "bash", sessionID: "s", callID: "c" }

describe("fork hooks plugin", () => {
  it.instance("PreToolUse exit 2 blocks the tool with stderr as the error", () =>
    withHooks(
      { PreToolUse: [{ matcher: "bash", command: guard }] },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const blocked = yield* plugin
          .trigger("tool.execute.before", before, { args: { command: "rm -rf /" } })
          .pipe(Effect.exit)
        expect(Exit.isFailure(blocked)).toBe(true)
        if (Exit.isFailure(blocked)) expect(Cause.pretty(blocked.cause)).toContain("destructive command")

        const safe = yield* plugin.trigger("tool.execute.before", before, { args: { command: "ls" } })
        expect(safe.args).toEqual({ command: "ls" })

        const other = yield* plugin.trigger(
          "tool.execute.before",
          { ...before, tool: "read" },
          { args: { command: "rm -rf /" } },
        )
        expect(other.args).toEqual({ command: "rm -rf /" })
      }),
    ),
  )

  it.instance("PreToolUse can rewrite the args in place", () =>
    withHooks(
      { PreToolUse: [{ command: json({ args: { command: "echo safe" } }) }] },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const args: Record<string, unknown> = { command: "echo hi", extra: true }
        yield* plugin.trigger("tool.execute.before", before, { args })
        expect(args).toEqual({ command: "echo safe" })
      }),
    ),
  )

  it.instance("PostToolUse appends additionalContext to the output", () =>
    withHooks(
      { PostToolUse: [{ matcher: "bash", command: json({ additionalContext: "remember the lint" }) }] },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const out = yield* plugin.trigger(
          "tool.execute.after",
          { ...before, args: {} },
          { title: "t", output: "done", metadata: {} },
        )
        expect(out.output).toBe("done\n\nremember the lint")
      }),
    ),
  )

  it.instance("PreCompact pushes additionalContext into the compacting context", () =>
    withHooks(
      { PreCompact: [{ command: json({ additionalContext: "keep the TODOs" }) }] },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const out = yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: "s" },
          { context: [] as string[], prompt: undefined },
        )
        expect(out.context).toEqual(["keep the TODOs"])
      }),
    ),
  )

  it.instance("permission.ask decisions short-circuit the permission service", () =>
    withHooks(
      {
        PermissionRequest: [
          { matcher: "bash", command: json({ decision: "allow" }) },
          { matcher: "edit", command: json({ decision: "deny" }) },
        ],
      },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const permission = yield* Permission.Service
        const request = (name: string) =>
          askWithPlugins(plugin, permission, {
            sessionID: "s" as never,
            permission: name,
            patterns: ["*"],
            metadata: {},
            always: [],
            ruleset: [],
          })

        yield* request("bash")
        const denied = yield* request("edit").pipe(Effect.flip)
        expect(denied).toBeInstanceOf(PermissionV1.DeniedError)

        const asked = yield* request("read").pipe(Effect.timeoutOption("200 millis"))
        expect(asked._tag).toBe("None")
      }),
    ),
  )

  it.instance("a hook allow never overrides a deny from the ruleset", () =>
    withHooks(
      { PermissionRequest: [{ command: json({ decision: "allow" }) }] },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const permission = yield* Permission.Service
        const denied = yield* askWithPlugins(plugin, permission, {
          sessionID: "s" as never,
          permission: "bash",
          patterns: ["rm"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }).pipe(Effect.flip)
        expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
      }),
    ),
  )
})
