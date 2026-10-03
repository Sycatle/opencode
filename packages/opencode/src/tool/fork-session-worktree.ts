// FORK-SEAM: session-worktree
import { Effect, Option, Schema } from "effect"
import { ForkSessionWorktree } from "@opencode-fork/core/session-worktree"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import * as Tool from "./tool"
import { ForkSessionCwd } from "./fork-session-cwd"
import { ForkWorktree } from "./fork-worktree"

// enter_worktree / exit_worktree: the main session works in a git worktree (see docs/fork/seams.md).
// Switching the directory is ForkSessionCwd; this file is the git side.

const EnterParameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({ description: "Short name of the worktree (default: random)" }),
  branch: Schema.optional(Schema.String).annotate({ description: "Branch to create (default: opencode/<name>)" }),
})

const ExitParameters = Schema.Struct({
  action: Schema.Literals(["keep", "merge", "discard"]).annotate({
    description:
      "keep: leave the worktree and its branch on disk. merge: commit pending changes, merge the branch into the original branch and remove the worktree. discard: delete the worktree and its branch, losing its changes (the user is asked first)",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "Commit message for the pending changes when action is merge",
  }),
})

const text = (title: string, output: string, metadata: Record<string, unknown> = {}) => ({ title, metadata, output })

export const EnterWorktreeTool = Tool.define(
  "enter_worktree",
  Effect.succeed({
    description:
      "Create an isolated git worktree on a new branch from the last commit (uncommitted changes are not included) and switch this session into it: file tools, bash, glob, grep and LSP then work there. Use it when the user asks for a worktree or for an isolated change. Leave it with exit_worktree.",
    parameters: EnterParameters,
    execute: (params: Schema.Schema.Type<typeof EnterParameters>, ctx: Tool.Context) =>
      enter(params, ctx).pipe(Effect.orDie),
  }),
)

export const ExitWorktreeTool = Tool.define(
  "exit_worktree",
  Effect.succeed({
    description:
      "Leave the worktree created by enter_worktree and return to the original directory. action is keep, merge or discard (discard deletes the worktree and its branch and needs the user's approval). Only works on a worktree entered in this session.",
    parameters: ExitParameters,
    execute: (params: Schema.Schema.Type<typeof ExitParameters>, ctx: Tool.Context) =>
      leave(params, ctx).pipe(Effect.orDie),
  }),
)

const enter = Effect.fn("EnterWorktree.execute")(function* (
  params: Schema.Schema.Type<typeof EnterParameters>,
  ctx: Tool.Context,
) {
  if (ForkSessionWorktree.get(ctx.sessionID))
    return yield* Effect.fail(new Error("This session is already in a worktree: call exit_worktree first"))
  const worktrees = yield* Effect.serviceOption(Worktree.Service)
  const stores = yield* Effect.serviceOption(InstanceStore.Service)
  if (Option.isNone(worktrees) || Option.isNone(stores))
    return yield* Effect.fail(new Error("Worktrees are not available in this environment"))
  const branch = params.branch?.trim()
  if (branch && !ForkSessionWorktree.validBranch(branch))
    return yield* Effect.fail(new Error(`Invalid branch name: ${branch}`))

  yield* ctx.ask({
    permission: "worktree",
    patterns: [params.name ?? "*"],
    always: ["*"],
    metadata: { action: "enter", name: params.name, branch },
  })

  const home = yield* InstanceState.context
  const info = yield* worktrees.value.makeWorktreeInfo({ name: ForkSessionWorktree.slug(params.name ?? "") })
  const target = ForkSessionWorktree.branchFor({ name: info.name, branch })
  const head = yield* ForkWorktree.git(["rev-parse", "HEAD"], home.worktree)
  if (head.code !== 0) return yield* Effect.fail(new Error(`A worktree needs a git commit: ${head.output}`))
  const current = yield* ForkWorktree.git(["symbolic-ref", "--short", "-q", "HEAD"], home.worktree)
  const added = yield* ForkWorktree.git(["worktree", "add", "-b", target, info.directory, "HEAD"], home.worktree)
  if (added.code !== 0) return yield* Effect.fail(new Error(`git worktree add failed: ${added.output}`))

  const origin = {
    directory: home.directory,
    root: home.worktree,
    branch: current.code === 0 ? current.output.trim() : undefined,
  }
  const mapped = ForkSessionWorktree.cwdIn(origin, info.directory)
  const exists = yield* Effect.promise(() => Bun.file(mapped).stat().then((stat) => stat.isDirectory(), () => false))
  const cwd = exists ? mapped : info.directory
  const instance = yield* stores.value.load({ directory: cwd })
  ForkSessionCwd.bind(
    ctx.sessionID,
    { name: info.name, branch: target, directory: info.directory, cwd, origin },
    instance,
  )
  return text(
    info.name,
    [
      `Entered worktree ${info.name} on branch ${target} (from ${head.output.trim().slice(0, 9)}).`,
      `Working directory: ${cwd}`,
      `From the next tool call on, file tools, bash, glob, grep and LSP work in this directory. Use paths under it (the original directory is ${origin.directory}).`,
    ].join("\n"),
    { branch: target, directory: cwd },
  )
})

const leave = Effect.fn("ExitWorktree.execute")(function* (
  params: Schema.Schema.Type<typeof ExitParameters>,
  ctx: Tool.Context,
) {
  const entry = ForkSessionWorktree.get(ctx.sessionID)
  if (!entry) return yield* Effect.fail(new Error("This session is not in a worktree created by enter_worktree"))
  const stores = yield* Effect.serviceOption(InstanceStore.Service)
  const root = entry.origin.root

  const dispose = Effect.fnUntraced(function* (branchFlag: "-d" | "-D") {
    if (Option.isSome(stores))
      yield* Effect.forEach(new Set([entry.cwd, entry.directory]), (dir) => stores.value.disposeDirectory(dir), {
        discard: true,
      })
    yield* ForkWorktree.git(["worktree", "remove", "--force", entry.directory], root)
    yield* ForkWorktree.git(["branch", branchFlag, entry.branch], root)
  })

  if (params.action === "keep") {
    ForkSessionCwd.unbind(ctx.sessionID)
    return text(
      "keep",
      `Back in ${entry.origin.directory}. The worktree ${entry.directory} and branch ${entry.branch} are kept.`,
    )
  }

  if (params.action === "discard") {
    const status = yield* ForkWorktree.git(["status", "--porcelain"], entry.directory)
    const ahead = yield* ForkWorktree.git(["rev-list", "--count", `HEAD..${entry.branch}`], root)
    // Its own permission: allowed by "*" rules would otherwise skip the question for a destructive action.
    yield* ctx.ask({
      permission: "worktree_discard",
      patterns: [entry.branch],
      always: [],
      metadata: {
        directory: entry.directory,
        branch: entry.branch,
        commits: ahead.output.trim(),
        changes: status.output.trim().split("\n").slice(0, 20).join("\n"),
      },
    })
    ForkSessionCwd.unbind(ctx.sessionID)
    yield* dispose("-D")
    return text("discard", `Back in ${entry.origin.directory}. Worktree ${entry.directory} and branch ${entry.branch} deleted.`)
  }

  const status = yield* ForkWorktree.git(["status", "--porcelain"], entry.directory)
  const ahead = yield* ForkWorktree.git(["rev-list", "--count", `HEAD..${entry.branch}`], root)
  const current = yield* ForkWorktree.git(["symbolic-ref", "--short", "-q", "HEAD"], root)
  const plan = ForkSessionWorktree.mergePlan({
    pending: status.output.trim() !== "",
    ahead: Number.parseInt(ahead.output.trim(), 10) || 0,
    originBranch: entry.origin.branch,
    currentBranch: current.code === 0 ? current.output.trim() : undefined,
  })
  if (plan.commit) {
    yield* ForkWorktree.git(["add", "-A"], entry.directory)
    // Project hooks run: a failing hook leaves the session in the worktree with the changes uncommitted.
    const committed = yield* ForkWorktree.git(
      ["commit", "-qm", ForkSessionWorktree.commitMessage(entry.name, params.message)],
      entry.directory,
    )
    if (committed.code !== 0) return yield* Effect.fail(new Error(`git commit failed: ${committed.output}`))
  }
  ForkSessionCwd.unbind(ctx.sessionID)
  if (!plan.merge)
    return text(
      "merge",
      `Back in ${entry.origin.directory}. Nothing was merged: ${plan.reason}. The worktree ${entry.directory} and branch ${entry.branch} are kept.`,
    )

  const merged = yield* ForkWorktree.git(["merge", "--no-edit", entry.branch], root)
  if (merged.code === 0) {
    yield* dispose("-d")
    return text(
      "merge",
      `Back in ${entry.origin.directory}. Branch ${entry.branch} is merged into ${entry.origin.branch} and the worktree is removed.\n${merged.output.trim()}`,
    )
  }
  const conflicts = yield* ForkWorktree.git(["diff", "--name-only", "--diff-filter=U"], root)
  const inProgress = yield* ForkWorktree.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], root)
  if (inProgress.code === 0) yield* ForkWorktree.git(["merge", "--abort"], root)
  return text(
    "merge",
    `Back in ${entry.origin.directory}.\n${ForkSessionWorktree.conflictReport({
      branch: entry.branch,
      origin: entry.origin.branch ?? "HEAD",
      files: conflicts.output.split("\n").filter(Boolean),
      error: merged.output,
    })}`,
    { conflict: true },
  )
})
