import { Effect } from "effect"
import { ForkSessionWorktree } from "@opencode-fork/core/session-worktree"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import type { Context } from "./tool"

// Fork-owned glue for enter_worktree / exit_worktree (see docs/fork/seams.md).
//
// A session's directory is the instance its fibers run in (InstanceRef), and that instance also routes the
// session's events and permission requests: the TUI listens on the directory it was started in. So a session
// that "moves" into a worktree swaps the instance for the execution of its tools only, and every call that
// must stay visible to the client (permission asks, tool metadata) hops back to the instance the turn runs in.

const instances = new Map<string, InstanceContext>()

export function bind(sessionID: string, entry: ForkSessionWorktree.Entry, instance: InstanceContext) {
  ForkSessionWorktree.set(sessionID, entry)
  instances.set(sessionID, instance)
}

export function unbind(sessionID: string) {
  ForkSessionWorktree.clear(sessionID)
  instances.delete(sessionID)
}

// exit_worktree runs in the instance the turn started in: it removes the worktree's own instance.
const HOME_TOOLS = new Set(["exit_worktree"])

// Executes a tool in the session's worktree, if it is in one.
export function run<A, E, R>(toolID: string, ctx: Context, execute: (ctx: Context) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const instance = instances.get(ctx.sessionID)
    if (!instance || HOME_TOOLS.has(toolID)) return yield* execute(ctx)
    const home = yield* InstanceRef
    const hop = <X, Err, Req>(effect: Effect.Effect<X, Err, Req>) =>
      home ? effect.pipe(Effect.provideService(InstanceRef, home)) : effect
    return yield* execute({
      ...ctx,
      ask: (input) => hop(ctx.ask(input)),
      metadata: (input) => hop(ctx.metadata(input)),
    }).pipe(Effect.provideService(InstanceRef, instance))
  })
}

// Runs an effect that only reads the session's directory (the environment block of the system prompt) in the worktree.
export function at(sessionID: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const instance = instances.get(sessionID)
    return instance ? effect.pipe(Effect.provideService(InstanceRef, instance)) : effect
  }
}

export * as ForkSessionCwd from "./fork-session-cwd"
