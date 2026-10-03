import { ForkCache } from "@opencode-fork/core/cache"
import { ForkJev } from "@opencode-fork/core/jev"
import { ForkTools } from "@opencode-fork/core/tools"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import type { Tool as AITool } from "ai"
import { PartID } from "./schema"
import type { Session } from "./session"

// Fork-owned glue for the tools-preload seam (session/tools.ts). Opt-in (OPENCODE_FORK_DEFER_TOOLS_JEV=1).
// On the first turn after a start or a compaction, or once the cache expired, Jev says which deferred tools the
// request will need, so the model does not spend a `tool_search` round trip on them. The choice is stored in an
// ignored text part of the user message (`forkPreloaded`), which `ForkTools.loadedTools` reads back every turn:
// the tool block then stays identical for the rest of the session.
export const make = (input: { sessions: Session.Interface; messages: SessionV1.WithParts[]; sessionID: string }) =>
  Effect.fn("ForkPreload.run")(function* (pool: Record<string, AITool>) {
    const mode = ForkJev.mode("DEFER_TOOLS", process.env, "off")
    const user = input.messages.findLast((message) => message.info.role === "user")
    if (mode === "off" || !user) return
    if (user.parts.some((part) => part.type === "text" && part.metadata?.forkPreloaded)) return
    const lastSummary = input.messages.findLastIndex((message) => message.info.role === "assistant" && message.info.summary)
    const answers = input.messages
      .slice(lastSummary + 1)
      .flatMap((message) => (message.info.role === "assistant" && !message.info.summary ? [message.info] : []))
    const last = answers.at(-1)
    if (
      !ForkTools.preloadWindow({
        turnsSinceStart: answers.length,
        idleMs: last ? Date.now() - (last.time.completed ?? last.time.created) : 0,
        ttlMs: ForkCache.systemTtl() ? 60 * 60_000 : 5 * 60_000,
      })
    )
      return
    const prompt = user.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n")
    const names = ForkTools.preloadCandidates(pool, prompt, ForkTools.loadedTools(input.messages))
    if (!names.length) return
    const response = yield* Effect.promise((signal) =>
      ForkJev.ask({ ...ForkTools.preloadRequest(pool, names, prompt), signal }),
    )
    const picked = response.answers ? ForkTools.preloadPicks(names, response.answers) : []
    ForkJev.journal({
      feature: "defer_tools",
      session_id: input.sessionID,
      ms: response.ms,
      ok: response.answers !== undefined,
      error: response.error,
      decision: `${picked.length}/${names.length}`,
      answers: response.answers,
    })
    if (!picked.length || mode === "shadow") return
    user.parts.push(
      yield* input.sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.info.id,
        sessionID: user.info.sessionID,
        type: "text",
        text: `Preloaded tools: ${picked.join(", ")}`,
        synthetic: true,
        ignored: true,
        metadata: { forkPreloaded: picked },
      }),
    )
  })

export * as ForkPreload from "./fork-preload"
