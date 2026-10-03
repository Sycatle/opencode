import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ForkSessionWorktree } from "@opencode-fork/core/session-worktree"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { LSP } from "@/lsp/lsp"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { EnterWorktreeTool, ExitWorktreeTool } from "../../src/tool/fork-session-worktree"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Worktree.node,
      Git.node,
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

const exists = (file: string) =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )

const git = (cwd: string, args: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  })

// Each test is its own session; the asks it triggered are collected.
const session = (id: string) => {
  const asked: { permission: string; patterns: readonly string[] }[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make(id),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asked.push({ permission: input.permission, patterns: input.patterns })
      }),
  }
  return {
    asked,
    enter: Effect.fnUntraced(function* (args: Tool.InferParameters<typeof EnterWorktreeTool>) {
      return yield* (yield* (yield* EnterWorktreeTool).init()).execute(args, ctx)
    }),
    leave: Effect.fnUntraced(function* (args: Tool.InferParameters<typeof ExitWorktreeTool>) {
      return yield* (yield* (yield* ExitWorktreeTool).init()).execute(args, ctx)
    }),
    write: Effect.fnUntraced(function* (args: Tool.InferParameters<typeof WriteTool>) {
      return yield* (yield* (yield* WriteTool).init()).execute(args, ctx)
    }),
  }
}

describe("session worktree", () => {
  afterEach(() => {
    ForkSessionWorktree.clear("ses_wt_merge")
    ForkSessionWorktree.clear("ses_wt_discard")
    ForkSessionWorktree.clear("ses_wt_conflict")
    ForkSessionWorktree.clear("ses_wt_keep")
  })

  it.instance(
    "enter, write lands in the worktree, merge brings it back",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const s = session("ses_wt_merge")
        const origin = yield* git(test.directory, ["symbolic-ref", "--short", "HEAD"])

        const entered = yield* s.enter({ name: "Merge Me" })
        const entry = ForkSessionWorktree.get("ses_wt_merge")!
        expect(entered.output).toContain(entry.directory)
        expect(entry.branch).toBe("opencode/merge-me")
        expect(entry.directory).not.toBe(test.directory)
        expect(s.asked[0]).toEqual({ permission: "worktree", patterns: ["Merge Me"] })

        yield* s.write({ filePath: "hello.txt", content: "from the worktree" })
        expect(yield* exists(path.join(entry.directory, "hello.txt"))).toBe(true)
        expect(yield* exists(path.join(test.directory, "hello.txt"))).toBe(false)

        const second = yield* s.enter({}).pipe(Effect.exit)
        expect(second._tag).toBe("Failure")

        const left = yield* s.leave({ action: "merge", message: "feat: hello" })
        expect(ForkSessionWorktree.get("ses_wt_merge")).toBeUndefined()
        expect(left.output).toContain(`merged into ${origin}`)
        expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "hello.txt")).text())).toBe(
          "from the worktree",
        )
        expect(yield* git(test.directory, ["log", "-1", "--format=%s"])).toBe("feat: hello")
        expect(yield* exists(entry.directory)).toBe(false)
        expect(yield* git(test.directory, ["branch", "--list", entry.branch])).toBe("")

        // Back in the original directory: the next write lands there.
        yield* s.write({ filePath: "after.txt", content: "origin" })
        expect(yield* exists(path.join(test.directory, "after.txt"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "enter then discard deletes the worktree after asking",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const s = session("ses_wt_discard")
        yield* s.enter({ name: "throwaway", branch: "scratch/throwaway" })
        const entry = ForkSessionWorktree.get("ses_wt_discard")!
        expect(entry.branch).toBe("scratch/throwaway")
        yield* s.write({ filePath: "lost.txt", content: "bye" })

        yield* s.leave({ action: "discard" })
        expect(s.asked.at(-1)?.permission).toBe("worktree_discard")
        expect(ForkSessionWorktree.get("ses_wt_discard")).toBeUndefined()
        expect(yield* exists(entry.directory)).toBe(false)
        expect(yield* git(test.directory, ["branch", "--list", "scratch/throwaway"])).toBe("")
        expect(yield* exists(path.join(test.directory, "lost.txt"))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "keep leaves the worktree and branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const s = session("ses_wt_keep")
        yield* s.enter({ name: "stay" })
        const entry = ForkSessionWorktree.get("ses_wt_keep")!
        yield* s.write({ filePath: "kept.txt", content: "k" })
        yield* s.leave({ action: "keep" })
        expect(s.asked.map((item) => item.permission)).not.toContain("worktree_discard")
        expect(yield* exists(path.join(entry.directory, "kept.txt"))).toBe(true)
        expect(yield* git(test.directory, ["branch", "--list", entry.branch])).toContain(entry.branch)
        const none = yield* s.leave({ action: "keep" }).pipe(Effect.exit)
        expect(none._tag).toBe("Failure")
      }),
    { git: true },
  )

  it.instance(
    "a conflicting merge is reported and breaks nothing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const s = session("ses_wt_conflict")
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.txt"), "base\n"))
        yield* git(test.directory, ["add", "-A"])
        yield* git(test.directory, ["commit", "-qm", "base"])
        yield* s.enter({ name: "clash" })
        const entry = ForkSessionWorktree.get("ses_wt_conflict")!
        yield* s.write({ filePath: "a.txt", content: "worktree side\n" })
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.txt"), "origin side\n"))
        yield* git(test.directory, ["commit", "-qam", "origin change"])

        const left = yield* s.leave({ action: "merge" })
        expect(left.metadata.conflict).toBe(true)
        expect(left.output).toContain("- a.txt")
        expect(ForkSessionWorktree.get("ses_wt_conflict")).toBeUndefined()
        expect(yield* git(test.directory, ["status", "--porcelain"])).toBe("")
        expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "a.txt")).text())).toBe("origin side\n")
        expect(yield* exists(entry.directory)).toBe(true)
        expect(yield* git(test.directory, ["branch", "--list", entry.branch])).toContain(entry.branch)
      }),
    { git: true },
  )
})
