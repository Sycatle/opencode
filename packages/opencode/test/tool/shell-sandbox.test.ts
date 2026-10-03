import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        BackgroundJob.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

type Request = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

const capture = (requests: Request[]) => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req: Request) => Effect.sync(() => void requests.push(req)),
})

const realHome = os.homedir()

// Needs a working bubblewrap: skipped where it is missing or user namespaces are disabled.
const usable =
  process.platform === "linux" &&
  Bun.which("bwrap") !== null &&
  Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--unshare-all", "true"], { stdout: "ignore", stderr: "ignore" })
    .exitCode === 0

describe.skipIf(!usable)("tool.shell sandbox", () => {
  const sandboxed = (sandbox: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { sandbox: { enabled: true, ...sandbox } } })
      const info = yield* ShellTool
      const shell = yield* info.init().pipe(provideInstance(tmp))
      return { tmp, shell, in: <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(tmp)) }
    })

  it.live("writes inside the project", () =>
    Effect.gen(function* () {
      const box = yield* sandboxed()
      const requests: Request[] = []
      const result = yield* box.in(box.shell.execute({ command: "echo hi > out.txt && cat out.txt" }, capture(requests)))
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("hi")
      expect(existsSync(path.join(box.tmp, "out.txt"))).toBe(true)
      expect(requests.map((request) => request.permission)).not.toContain("sandbox_escape")
    }),
  )

  it.live("cannot write in $HOME and says why", () =>
    Effect.gen(function* () {
      const probe = path.join(realHome, `.fork-sandbox-probe-${process.pid}`)
      const box = yield* sandboxed()
      const result = yield* box.in(
        box.shell.execute({ command: `touch ${probe}` }, capture([])),
      ).pipe(Effect.ensuring(Effect.sync(() => rmSync(probe, { force: true }))))
      expect(result.metadata.exit).not.toBe(0)
      expect(result.output).toContain("Read-only file system")
      expect(result.output).toContain("[sandbox]")
      expect(result.output).toContain("`sandbox: false`")
      expect(existsSync(probe)).toBe(false)
    }),
  )

  it.live("hides read_deny paths", () =>
    Effect.gen(function* () {
      const secrets = path.join(os.tmpdir(), `fork-sandbox-secrets-${process.pid}`)
      mkdirSync(secrets, { recursive: true })
      writeFileSync(path.join(secrets, "id_rsa"), "PRIVATE")
      const box = yield* sandboxed({ read_deny: [secrets] })
      const result = yield* box.in(
        box.shell.execute({ command: `cat ${secrets}/id_rsa; ls -A ${secrets} | wc -l` }, capture([])),
      ).pipe(Effect.ensuring(Effect.sync(() => rmSync(secrets, { recursive: true, force: true }))))
      expect(result.output).not.toContain("PRIVATE")
      expect(result.output).toContain("No such file")
      expect(result.output.trim().endsWith("0")).toBe(true)
    }),
  )

  describe.skipIf(Bun.which("curl") === null)("curl", () => {
    it.live("has no network without an allow list", () =>
      Effect.gen(function* () {
        const box = yield* sandboxed()
        const result = yield* box.in(
          box.shell.execute({ command: "curl -sS -m 5 http://example.com" }, capture([])),
        )
        expect(result.metadata.exit).not.toBe(0)
        expect(result.output).toContain("network is disabled")
      }),
    )
  })

  it.live("keeps the host network namespace when a domain is allowed", () =>
    Effect.gen(function* () {
      const open = yield* sandboxed({ network: { allow: ["example.com"] } })
      const closed = yield* sandboxed()
      const ns = { command: "readlink /proc/self/ns/net" }
      const host = readlinkSync("/proc/self/ns/net")
      expect((yield* open.in(open.shell.execute(ns, capture([])))).output.trim()).toBe(host)
      expect((yield* closed.in(closed.shell.execute(ns, capture([])))).output.trim()).not.toBe(host)
    }),
  )

  it.live("escaping the sandbox asks for sandbox_escape", () =>
    Effect.gen(function* () {
      const box = yield* sandboxed()
      const requests: Request[] = []
      const result = yield* box.in(box.shell.execute({ command: "echo free", sandbox: false }, capture(requests)))
      expect(result.output).toContain("free")
      expect(requests.filter((request) => request.permission === "sandbox_escape")).toEqual([
        expect.objectContaining({ patterns: ["echo free"], always: [] }),
      ])
    }),
  )
})
