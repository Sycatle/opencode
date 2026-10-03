import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ForkJev } from "@opencode-fork/core/jev"
import { ForkPins } from "@opencode-fork/core/pins"
import { ForkCompaction } from "@opencode-fork/core/compaction"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import type { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import { Session } from "./session"
import { Token } from "@/util/token"

// Fork-owned glue for packages/fork/src/compaction.ts (see docs/fork/seams.md).

// Summarizes by replaying the session's last provider request with a final summary
// instruction, so the context is read from the prompt cache. Returns false when the
// cache is likely cold or the model did not produce a usable summary; the caller
// then falls back to upstream compaction.
export const cachedSummary = Effect.fn("ForkCompaction.cachedSummary")(function* (input: {
  llm: LLM.Interface
  session: Session.Interface
  history: SessionV1.WithParts[]
  message: SessionV1.Assistant
  legacyTokens: number
}) {
  if (!ForkCompaction.enabled()) return false
  const last = ForkCompaction.recall<LLM.StreamInput>(input.message.sessionID)
  if (!last) return false
  const index = input.history.findIndex((message) => message.info.id === last.messageID)
  if (index === -1) return false
  const delta = yield* MessageV2.toModelMessagesEffect(input.history.slice(index), last.input.model)
  const previous = input.history[index].info
  const cost = last.input.model.cost
  if (
    previous.role !== "assistant" ||
    !ForkCompaction.worthIt({
      context: previous.tokens.input + previous.tokens.cache.read + previous.tokens.cache.write,
      delta: Token.estimate(JSON.stringify(delta)),
      legacy: input.legacyTokens,
      cacheRatio: cost?.input ? (cost.cache?.read ?? cost.input) / cost.input : 1,
    })
  )
    return false

  const collected: { text: string; toolCalls: number; finish?: Extract<LLMEvent, { type: "step-finish" }> } = {
    text: "",
    toolCalls: 0,
  }
  yield* input.llm
    .stream({
      ...last.input,
      messages: [...last.input.messages, ...delta, { role: "user", content: ForkCompaction.PROMPT }],
      // Same definitions keep the cached prefix intact; without execute nothing can run.
      tools: Object.fromEntries(
        Object.entries(last.input.tools).map(([name, tool]) => [name, { ...tool, execute: undefined }]),
      ),
    })
    .pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "text-delta") collected.text += event.text
          if (event.type === "tool-call") collected.toolCalls++
          if (event.type === "step-finish") collected.finish = event
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("cached compaction failed, falling back", { cause: String(cause) }),
      ),
    )

  const usage = Session.getUsage({
    model: last.input.model,
    usage: collected.finish?.usage ?? new Usage({}),
    metadata: collected.finish?.providerMetadata,
  })
  void ForkTelemetry.record({
    sessionID: input.message.sessionID,
    messageID: input.message.id,
    providerID: last.input.model.providerID,
    modelID: last.input.model.id,
    agent: "compaction-cached",
    tokens: usage.tokens,
    cost: usage.cost,
  })
  input.message.cost += usage.cost
  input.message.tokens = usage.tokens
  if (!ForkCompaction.acceptable(collected)) {
    yield* Effect.logWarning("cached compaction unusable, falling back", { toolCalls: collected.toolCalls })
    yield* input.session.updateMessage(input.message)
    return false
  }

  const now = Date.now()
  yield* input.session.updatePart({
    id: PartID.ascending(),
    messageID: input.message.id,
    sessionID: input.message.sessionID,
    type: "text",
    text: collected.text.trim(),
    time: { start: now, end: now },
  })
  input.message.finish = "stop"
  input.message.time.completed = now
  yield* input.session.updateMessage(input.message)
  return true
})

// Appends facts taken from structured session data to a finished summary.
export const appendFacts = Effect.fn("ForkCompaction.appendFacts")(function* (input: {
  session: Session.Interface
  history: SessionV1.WithParts[]
  message: SessionV1.Assistant
}) {
  const facts = ForkCompaction.facts(input.history)
  if (ForkJev.mode("PINS") !== "off") yield* autoPin(input.message.sessionID, input.history)
  const text = [ForkCompaction.formatFacts(facts), ForkPins.format(ForkPins.list(input.message.sessionID))]
    .filter(Boolean)
    .join("\n\n")
  if (!text) return
  const now = Date.now()
  yield* input.session.updatePart({
    id: PartID.ascending(),
    messageID: input.message.id,
    sessionID: input.message.sessionID,
    type: "text",
    text,
    time: { start: now, end: now },
    metadata: { forkFacts: facts },
  })
})

// Jev picks the user messages that state a lasting constraint or decision and pins them for the summary.
// The compaction already waits for a model call, so the extra Jev round trip is not on a critical path.
const autoPin = Effect.fn("ForkCompaction.autoPin")(function* (sessionID: SessionV1.Assistant["sessionID"], history: SessionV1.WithParts[]) {
  const pinned = ForkPins.list(sessionID)
  const items = ForkPins.candidates(
    history.flatMap((message) => {
      if (message.info.role !== "user") return []
      const text = message.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
        .join("\n")
      return text ? [{ message_id: message.info.id, text }] : []
    }),
    pinned,
  )
  if (!items.length) return
  const response = yield* Effect.promise((signal) => ForkJev.ask({ ...ForkPins.jevRequest(items), signal }))
  const picks = response.answers ? ForkPins.picks(items, response.answers, pinned.filter((pin) => pin.auto).length) : []
  const added = picks.filter((pick) => ForkPins.add(sessionID, pick.message_id, pick.text))
  ForkJev.journal({
    feature: "pins",
    session_id: sessionID,
    ms: response.ms,
    ok: response.answers !== undefined,
    error: response.error,
    decision: `${added.length}/${items.length}`,
    answers: response.answers,
  })
})

export * as ForkCompactionRun from "./fork-compaction"
