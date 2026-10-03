import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Fiber, Queue } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { PlanEnterTool } from "@/tool/plan"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Database.node,
      EventV2Bridge.node,
      Provider.node,
      Question.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
    ]),
  ),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const pending = Effect.fn("PlanToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const item = (yield* question.list())[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

const start = Effect.fn("PlanToolTest.start")(function* () {
  const question = yield* Question.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Pinned" })
  yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const tool = yield* (yield* PlanEnterTool).init()
  const fiber = yield* tool
    .execute(
      {},
      {
        sessionID: chat.id,
        messageID: MessageID.ascending(),
        callID: "call",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    .pipe(Effect.forkScoped)
  return { chat, fiber, item: yield* pending(question) }
})

describe("tool.plan_enter", () => {
  it.instance("Yes adds a synthetic user message for the plan agent", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const sessions = yield* Session.Service
      const run = yield* start()
      expect(run.item.questions[0]?.question).toContain("/plans/")
      yield* question.reply({ requestID: run.item.id, answers: [["Yes"]] })

      const result = yield* Fiber.join(run.fiber)
      expect(result.title).toBe("Switching to plan agent")
      const last = (yield* sessions.messages({ sessionID: run.chat.id })).at(-1)
      expect(last?.info).toMatchObject({ role: "user", agent: "plan", model: ref })
      expect(last?.parts[0]).toMatchObject({ type: "text", synthetic: true })
    }),
  )

  it.instance("No rejects and leaves the session untouched", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const sessions = yield* Session.Service
      const run = yield* start()
      yield* question.reply({ requestID: run.item.id, answers: [["No"]] })

      expect(yield* Fiber.await(run.fiber)).toMatchObject({ _tag: "Failure" })
      const messages = yield* sessions.messages({ sessionID: run.chat.id })
      expect(messages.map((item) => item.info.agent)).toEqual(["build"])
    }),
  )
})
