import { afterEach, beforeEach, expect, test } from "bun:test"
import { ForkCache } from "../src/cache"

// The TUI exports OPENCODE_FORK_CACHE_TTL to its children, so a suite launched from a session inherits it.
beforeEach(() => {
  delete process.env.OPENCODE_FORK_CACHE_TTL
  delete process.env.OPENCODE_FORK_AUTH_CACHE
})

afterEach(() => {
  delete process.env.OPENCODE_FORK_CACHE_TTL
  delete process.env.OPENCODE_FORK_AUTH_CACHE
})

test("the 1h TTL is opt-in through the environment", () => {
  expect(ForkCache.systemTtl()).toBeUndefined()
  process.env.OPENCODE_FORK_CACHE_TTL = "1h"
  expect(ForkCache.systemTtl()).toBe("1h")
})

test("1h cache writes are billed at 2x input instead of the 5m write price", () => {
  const metadata = { anthropic: { usage: { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } } } }
  // Sonnet-like pricing: $3 input, $3.75 5m write -> 1h write is $6, so $2.25 extra per million.
  expect(ForkCache.extraWriteCost({ metadata, price: { input: 3, cache: { write: 3.75 } } })).toBeCloseTo(2.25)
  expect(ForkCache.extraWriteCost({ metadata: {}, price: { input: 3 } })).toBe(0)
  expect(ForkCache.extraWriteCost({ metadata, price: undefined })).toBe(0)
})

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const cc5 = { type: "ephemeral" }
const cc1h = { type: "ephemeral", ttl: "1h" }

// Body as opencode hands it to the plugin fetch: identity-led system block, markers on
// the system blocks and on the last message.
function request(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    system: [
      { type: "text", text: `${IDENTITY}\nYou are opencode...`, cache_control: cc5 },
      { type: "text", text: "Instructions from AGENTS.md", cache_control: cc5 },
    ],
    tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "fix the bug" }] },
      { role: "assistant", content: [{ type: "text", text: "looking" }] },
      { role: "user", content: [{ type: "text", text: "and the tests", cache_control: cc5 }] },
    ],
    ...overrides,
  })
}

test("auth cache needs the interactive TTL and honors the opt-out", () => {
  expect(ForkCache.authCacheEnabled()).toBe(false)
  process.env.OPENCODE_FORK_CACHE_TTL = "1h"
  expect(ForkCache.authCacheEnabled()).toBe(true)
  process.env.OPENCODE_FORK_AUTH_CACHE = "0"
  expect(ForkCache.authCacheEnabled()).toBe(false)
})

test("only Anthropic Messages URLs are rewritten", () => {
  expect(ForkCache.isMessagesRequest("https://api.anthropic.com/v1/messages")).toBe(true)
  expect(ForkCache.isMessagesRequest(new URL("https://api.anthropic.com/v1/messages?beta=true"))).toBe(true)
  expect(ForkCache.isMessagesRequest("https://api.openai.com/v1/responses")).toBe(false)
})

test("the first user message ends with a 1h breakpoint and later markers stay", () => {
  const out = JSON.parse(ForkCache.pinFirstUserMessage(request())!)
  expect(out.messages[0].content.at(-1).cache_control).toEqual(cc1h)
  expect(out.messages[2].content[0].cache_control).toEqual(cc5)
  expect(out.messages[0].content[0].text).toBe("fix the bug")
})

test("a string first message becomes a block so it can carry the marker", () => {
  const out = JSON.parse(ForkCache.pinFirstUserMessage(request({ messages: [{ role: "user", content: "hello" }] }))!)
  expect(out.messages[0].content).toEqual([{ type: "text", text: "hello", cache_control: cc1h }])
})

test("an existing marker on the first message is promoted, not duplicated", () => {
  const body = request({ messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: cc5 }] }] })
  const out = JSON.parse(ForkCache.pinFirstUserMessage(body)!)
  expect(out.messages[0].content).toEqual([{ type: "text", text: "hi", cache_control: cc1h }])
  expect(ForkCache.pinFirstUserMessage(JSON.stringify(out))).toBeUndefined()
})

test("tool markers are promoted so 1h entries precede 5m ones", () => {
  const out = JSON.parse(ForkCache.pinFirstUserMessage(request({ tools: [{ name: "bash", cache_control: cc5 }] }))!)
  expect(out.tools[0].cache_control.ttl).toBe("1h")
})

test("earlier blocks of the first message are promoted so no 5m marker precedes the 1h one", () => {
  const first = {
    role: "user",
    content: [
      { type: "text", text: "<system-reminder>skills</system-reminder>", cache_control: cc5 },
      { type: "text", text: "fix the bug" },
    ],
  }
  const out = JSON.parse(ForkCache.pinFirstUserMessage(request({ messages: [first] }))!)
  expect(out.messages[0].content.map((block: { cache_control?: { ttl?: string } }) => block.cache_control?.ttl)).toEqual([
    "1h",
    "1h",
  ])
})

test("never exceeds four breakpoints", () => {
  const tools = [
    { name: "a", cache_control: cc5 },
    { name: "b", cache_control: cc5 },
  ]
  const messages = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two", cache_control: cc5 }] },
    { role: "user", content: [{ type: "text", text: "three", cache_control: cc5 }] },
  ]
  expect(ForkCache.pinFirstUserMessage(request({ tools, messages }))).toBeUndefined()
})

test("requests the plugin does not relocate are left alone", () => {
  expect(ForkCache.pinFirstUserMessage(request({ system: [{ type: "text", text: "plain prompt" }] }))).toBeUndefined()
  expect(ForkCache.pinFirstUserMessage("not json")).toBeUndefined()
  expect(ForkCache.pinFirstUserMessage(undefined)).toBeUndefined()
})
