import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import type { InstanceStore } from "@/project/instance-store"
import type { Worktree } from "@/worktree"

// Fork-owned glue for `task` with isolation: "worktree" (see docs/fork/seams.md).
// The subagent runs in its own opencode instance rooted at a fresh git worktree,
// so parallel subagents never edit the same files. Its changes come back as a
// commit on a branch the parent can merge.

export type Isolated = {
  branch: string
  directory: string
  root: string
  base: string
  instance: InstanceContext
}

export const open = Effect.fn("ForkWorktree.open")(function* (input: {
  worktree: Worktree.Interface
  store: InstanceStore.Interface
  name: string
}) {
  const ctx = yield* InstanceState.context
  const info = yield* input.worktree.makeWorktreeInfo({ name: input.name })
  if (!info.branch) return yield* Effect.fail(new Error("Worktree isolation needs a branch"))
  const base = yield* git(["rev-parse", "HEAD"], ctx.worktree)
  if (base.code !== 0) return yield* Effect.fail(new Error(`Worktree isolation needs a git commit: ${base.output}`))
  // Synchronous add: upstream's create() populates and boots the worktree in the background.
  const added = yield* git(["worktree", "add", "-b", info.branch, info.directory, "HEAD"], ctx.worktree)
  if (added.code !== 0) return yield* Effect.fail(new Error(`git worktree add failed: ${added.output}`))
  const instance = yield* input.store.load({ directory: info.directory })
  return {
    branch: info.branch,
    directory: info.directory,
    root: ctx.worktree,
    base: base.output.trim(),
    instance,
  } satisfies Isolated
})

// Commits the subagent's work on its branch, removes the worktree (the branch stays)
// and returns a report for the parent.
export const close = Effect.fn("ForkWorktree.close")(function* (input: {
  isolated: Isolated
  store: InstanceStore.Interface
  message: string
}) {
  const dir = input.isolated.directory
  yield* git(["add", "-A"], dir)
  const status = yield* git(["status", "--porcelain"], dir)
  // --no-verify: project hooks (lint, typecheck) belong to the parent's review, not to this commit.
  if (status.output.trim())
    yield* git(["commit", "--no-verify", "-qm", input.message], dir)
  const stat = yield* git(["diff", "--stat", `${input.isolated.base}..${input.isolated.branch}`], input.isolated.root)
  yield* input.store.disposeDirectory(dir)
  yield* git(["worktree", "remove", "--force", dir], input.isolated.root)
  if (!stat.output.trim()) {
    yield* git(["branch", "-D", input.isolated.branch], input.isolated.root)
    return "Worktree isolation: the subagent made no file changes."
  }
  return [
    `Worktree isolation: changes are committed on branch ${input.isolated.branch} (not applied to your working tree).`,
    stat.output.trimEnd(),
    `Review with \`git diff HEAD...${input.isolated.branch}\`, apply with \`git merge ${input.isolated.branch}\`, discard with \`git branch -D ${input.isolated.branch}\`.`,
  ].join("\n")
})

const git = (args: string[], cwd: string) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, output: stdout || stderr }
  })

export * as ForkWorktree from "./fork-worktree"
