import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { ForkClassifier } from "@opencode-fork/core/classifier"
import { ForkHooks } from "@opencode-fork/core/hooks"
import fs from "fs/promises"
import os from "os"
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
import { createForkHooksPlugin } from "../../src/plugin/fork-hooks"
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

  it.instance("auto mode approves every ask without prompting and keeps explicit denies", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const permission = yield* Permission.Service
      const request = (name: string, ruleset: PermissionV1.Ruleset) =>
        askWithPlugins(plugin, permission, {
          sessionID: "s" as never,
          permission: name,
          patterns: ["*"],
          metadata: {},
          always: [],
          ruleset,
        })
      const auto = ForkClassifier.withMode([], "auto")
      for (const name of ["edit", "bash", "sandbox_escape", "worktree_discard"])
        expect((yield* request(name, auto).pipe(Effect.timeoutOption("200 millis")))._tag).toBe("Some")
      const denied = yield* request("edit", [...auto, { permission: "edit", pattern: "*", action: "deny" }]).pipe(
        Effect.flip,
      )
      expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
    }),
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

describe("fork hooks events and hook types", () => {
  // `hooks` may be built from `record`, a command hook that appends each event payload to the log read by `events`.
  const start = async (
    hooks: Record<string, unknown> | ((record: { command: string }) => Record<string, unknown>),
    deps?: ForkHooks.Deps,
  ) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-hooks-"))
    const log = path.join(dir, "log")
    const input = { directory: dir, client: { app: { log: async () => undefined } } } as unknown as PluginInput
    const plugin = await createForkHooksPlugin(input, deps)
    const record = { command: `cat >> ${log}; echo >> ${log}` }
    await plugin.config?.({ hooks: typeof hooks === "function" ? hooks(record) : hooks } as never)
    const events = async () =>
      (
        await Bun.file(log)
          .text()
          .catch(() => "")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ForkHooks.Payload)
    const emit = (type: string, properties: unknown) => plugin.event!({ event: { type, properties } as never })
    return { plugin, record, events, emit }
  }

  test("SubagentStop fires for a finished child session, Stop and idle Notification for the root", async () => {
    const run = await start((record) => ({ SubagentStop: [record], Stop: [record], Notification: [record] }))
    await run.emit("session.created", { info: { id: "root" } })
    await run.emit("session.created", { info: { id: "child", parentID: "root" } })
    await run.emit("message.updated", {
      sessionID: "child",
      info: { sessionID: "child", role: "assistant", agent: "explore" },
    })
    await run.emit("session.idle", { sessionID: "child" })
    expect((await run.events()).map((e) => [e.event, e.sessionID, e.parentID, e.agent])).toEqual([
      ["SubagentStop", "child", "root", "explore"],
    ])
    await run.emit("session.idle", { sessionID: "root" })
    const events = await run.events()
    expect(events.slice(1).map((e) => [e.event, e.notificationType])).toEqual(
      expect.arrayContaining([
        ["Stop", undefined],
        ["Notification", "idle"],
      ]),
    )
    expect(events).toHaveLength(3)
  })

  test("SessionEnd fires on deletion and, for the sessions still alive, on dispose", async () => {
    const run = await start((record) => ({ SessionEnd: [record] }))
    await run.emit("session.created", { info: { id: "a" } })
    await run.emit("session.created", { info: { id: "b", parentID: "a" } })
    await run.emit("session.deleted", { sessionID: "a", info: { id: "a" } })
    expect((await run.events()).map((e) => [e.sessionID, e.reason])).toEqual([["a", "deleted"]])
    await run.plugin.dispose!()
    expect((await run.events()).map((e) => [e.sessionID, e.parentID, e.reason])).toEqual([
      ["a", undefined, "deleted"],
      ["b", "a", "exit"],
    ])
  })

  test("Notification fires for permission and question requests", async () => {
    const run = await start((record) => ({ Notification: [record] }))
    await run.emit("permission.asked", { sessionID: "s", permission: "bash", patterns: ["rm *"] })
    await run.emit("question.asked", { sessionID: "s", questions: [{ question: "Which one?" }] })
    expect((await run.events()).map((e) => [e.notificationType, e.message])).toEqual([
      ["permission", "Permission requested: bash rm *"],
      ["question", "Which one?"],
    ])
  })

  test("PostToolUseFailure appends context to the error, except for calls a PreToolUse hook blocked", async () => {
    const run = await start({
      PreToolUse: [{ matcher: "edit", command: 'echo "blocked" >&2; exit 2' }],
      PostToolUseFailure: [{ matcher: "bash", command: json({ additionalContext: "check the cwd" }) }],
    })
    const failure = { tool: "bash", sessionID: "s", callID: "c1", args: { command: "false" } }
    const out = { error: "exit 1" }
    await run.plugin["tool.execute.failure"]!(failure, out)
    expect(out.error).toBe("exit 1\n\ncheck the cwd")

    const edit = { tool: "edit", sessionID: "s", callID: "c2" }
    await run.plugin["tool.execute.before"]!(edit, { args: {} }).catch(() => undefined)
    const skipped = { error: "blocked" }
    await run.plugin["tool.execute.failure"]!({ ...edit, args: {} }, skipped)
    expect(skipped.error).toBe("blocked")
  })

  test("prompt hooks block through the injected model", async () => {
    const prompts: string[] = []
    const run = await start(
      { PreToolUse: [{ type: "prompt", prompt: "Allow? $ARGUMENTS", matcher: "bash" }] },
      {
        ask: async (prompt) => {
          prompts.push(prompt)
          return '{"ok": false, "reason": "model says no"}'
        },
      },
    )
    const blocked = await run.plugin["tool.execute.before"]!(
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: {} },
    ).then(
      () => undefined,
      (error: Error) => error.message,
    )
    expect(blocked).toBe("model says no")
    expect(prompts[0]).toContain('"tool":"bash"')
  })

  test("http hooks decide permission requests", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ decision: "deny" }) })
    const run = await start({ PermissionRequest: [{ type: "http", url: `http://localhost:${server.port}/hook` }] })
    const output = { status: "ask" as "ask" | "deny" | "allow" }
    await run.plugin["permission.ask"]!({ type: "bash", pattern: "*", sessionID: "s" } as never, output)
    server.stop(true)
    expect(output.status).toBe("deny")
  })
})
