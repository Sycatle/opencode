// Fork: with Anthropic's native tool search, deferred tools go out with defer_loading next to the server search tool,
// and a past server search replays as tool_search_tool_result, even once pruning cleared old tool outputs.
import { expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { jsonSchema, streamText, tool, type Tool } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ForkTools } from "@opencode-fork/core/tools"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_native")
const providerID = ProviderV2.ID.make("anthropic")
const model = {
  id: ModelV2.ID.make("claude-haiku-4-5"),
  providerID,
  api: { id: "claude-haiku-4-5", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
  name: "Haiku",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
  limit: { context: 200_000, output: 8_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-10-01",
} as Provider.Model

const part = (messageID: string, id: string) => ({ id: PartID.make(`prt_${id}`), sessionID, messageID: MessageID.make(messageID) })
const user = (id: string, text: string): SessionV1.WithParts => ({
  info: { id, sessionID, role: "user", time: { created: 0 }, agent: "build", model: { providerID, modelID: model.id } } as unknown as SessionV1.User,
  parts: [{ ...part(id, `${id}-text`), type: "text", text }] as SessionV1.Part[],
})

const weather = tool({
  description: "Current weather for a city",
  inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  execute: async () => "sunny",
})

test("deferred tools carry defer_loading, and a pruned server search still replays as tool_search_tool_result", async () => {
  const assistantID = "msg_native_a1"
  const history: SessionV1.WithParts[] = [
    user("msg_native_u1", "weather in Paris?"),
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: "msg_native_u1",
        time: { created: 1, completed: 2 },
        modelID: model.id,
        providerID,
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } as unknown as SessionV1.Assistant,
      parts: [
        {
          ...part(assistantID, "search"),
          type: "tool",
          callID: "srvtoolu_1",
          tool: ForkTools.NATIVE_SEARCH,
          state: {
            status: "completed",
            input: { query: "weather" },
            output: JSON.stringify([{ type: "tool_reference", toolName: "weather_get" }]),
            title: "search",
            metadata: {},
            // Pruned: the replay must ignore it for a server search.
            time: { start: 0, end: 1, compacted: 2 },
          },
          metadata: { providerExecuted: true },
        },
        {
          ...part(assistantID, "call"),
          type: "tool",
          callID: "toolu_2",
          tool: "weather_get",
          state: {
            status: "completed",
            input: { city: "Paris" },
            output: "sunny",
            title: "weather",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ] as SessionV1.Part[],
    },
    user("msg_native_u2", "and in Lyon?"),
  ]

  const { anthropic } = await import("@ai-sdk/anthropic")
  const tools = ForkTools.deferNative(
    { weather_get: weather, read: tool({ description: "Read a file", inputSchema: jsonSchema({ type: "object" }) }) },
    ["weather_get"],
    history,
    anthropic.tools.toolSearchBm25_20251119() as unknown as Tool,
  )

  const sent: Record<string, unknown>[] = []
  const provider = createAnthropic({
    apiKey: "test",
    fetch: (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), {
        status: 400,
      })
    }) as typeof fetch,
  })
  const result = streamText({
    model: provider("claude-haiku-4-5"),
    messages: await MessageV2.toModelMessages(history, model),
    tools,
    maxRetries: 0,
  })
  await result.consumeStream({ onError: () => {} })

  const body = sent[0] as { tools: Record<string, unknown>[]; messages: { role: string; content: Record<string, unknown>[] }[] }
  expect(body.tools).toContainEqual(expect.objectContaining({ name: "weather_get", defer_loading: true }))
  expect(body.tools.find((item) => item.name === "read")).not.toHaveProperty("defer_loading")
  expect(body.tools).toContainEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" })
  const replayed = body.messages.flatMap((message) => message.content)
  expect(replayed).toContainEqual(
    expect.objectContaining({ type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25" }),
  )
  expect(replayed).toContainEqual(
    expect.objectContaining({
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "weather_get" }] },
    }),
  )
})
