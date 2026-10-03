import { ForkContext } from "@opencode-fork/core/context"
import { ForkJev } from "@opencode-fork/core/jev"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Token } from "@/util/token"
import type { Session } from "./session"

// Fork-owned glue for the prune-keep seam of compaction.ts. Opt-in (OPENCODE_FORK_PRUNE_JEV=1): the outputs
// that Jev expects the agent to need again are spared by this batch. Never on the critical path (prune runs in
// a forked fiber), and any failure prunes the whole batch as before.
export const keep = Effect.fn("ForkPrune.keep")(function* (input: {
  session: Session.Interface
  sessionID: string
  messages: SessionV1.WithParts[]
  batch: SessionV1.ToolPart[]
  minimum: number
}) {
  const none = new Set<string>()
  const mode = ForkJev.mode("PRUNE", process.env, "off")
  if (mode === "off") return none
  const items = ForkContext.pruneAsk(
    input.batch.flatMap((part) =>
      part.state.status === "completed" && !part.metadata?.forkKept
        ? [
            {
              id: part.id,
              tool: part.tool,
              title: part.state.title ?? "",
              excerpt: part.state.output,
              tokens: Token.estimate(part.state.output),
            },
          ]
        : [],
    ),
  )
  if (!items.length) return none
  const user = input.messages.findLast((message) => message.info.role === "user")
  const request = ForkContext.pruneRequest(
    items,
    (user?.parts ?? []).flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n"),
  )
  const response = yield* Effect.promise(() => ForkJev.ask(request))
  const kept = response.answers
    ? ForkContext.pruneKeeps(
        items,
        response.answers,
        {
          count: input.batch.length,
          tokens: input.batch.reduce(
            (sum, part) => sum + (part.state.status === "completed" ? Token.estimate(part.state.output) : 0),
            0,
          ),
        },
        input.minimum,
      )
    : none
  ForkJev.journal({
    feature: "prune",
    session_id: input.sessionID,
    ms: response.ms,
    ok: response.answers !== undefined,
    error: response.error,
    decision: `${kept.size}/${items.length}`,
    answers: response.answers,
  })
  if (mode === "shadow") return none
  // A spared output is marked so the next batch does not ask again; it is pruned then like any other.
  yield* Effect.forEach(
    input.batch.filter((part) => kept.has(part.id)),
    (part) => input.session.updatePart({ ...part, metadata: { ...part.metadata, forkKept: true } }),
  )
  return kept
})

export * as ForkPrune from "./fork-prune"
