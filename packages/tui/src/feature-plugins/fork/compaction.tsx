import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { ForkCompaction } from "@opencode-fork/core/compaction"
import { ForkPins } from "@opencode-fork/core/pins"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import type { BuiltinTuiPlugin } from "../builtins"

// Fork palette commands (see docs/fork/seams.md): pin messages so compaction keeps
// them verbatim, and preview what compacting now would cost.

const id = "fork:compaction"
const PIN_CANDIDATES = 40

function currentSession(api: TuiPluginApi) {
  const current = api.route.current
  if (current.name !== "session" || !("params" in current)) return undefined
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function textOf(api: TuiPluginApi, message: Message) {
  return api.state
    .part(message.id)
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("\n")
    .trim()
}

function showPins(api: TuiPluginApi, sessionID: string) {
  const pinned = new Set(ForkPins.list(sessionID).map((pin) => pin.message_id))
  const options = api.state.session
    .messages(sessionID)
    .flatMap((message) => {
      const text = textOf(api, message)
      return text ? [{ message, text }] : []
    })
    .slice(-PIN_CANDIDATES)
    .toReversed()
    .map((item) => ({
      title: item.text.replaceAll("\n", " ").slice(0, 90),
      value: item.message.id,
      category: item.message.role === "user" ? "You" : "Assistant",
      footer: pinned.has(item.message.id) ? "pinned" : undefined,
      onSelect: () => {
        const now = ForkPins.toggle(sessionID, item.message.id, item.text)
        api.ui.toast({ message: now ? "Pinned: kept verbatim through compaction" : "Unpinned", variant: "info" })
        showPins(api, sessionID)
      },
    }))
  api.ui.dialog.replace(() => <api.ui.DialogSelect title="Pin messages for compaction" options={options} />)
}

function showPreview(api: TuiPluginApi, sessionID: string) {
  const messages = api.state.session.messages(sessionID)
  const boundary = messages.findLastIndex((message) => message.role === "assistant" && message.summary === true)
  const window = messages.slice(boundary + 1)
  const parts = (message: Message) => api.state.part(message.id).map(toPreviewPart)
  const last = ForkTelemetry.steps(sessionID).at(-1)
  const lastAssistant = window.findLast((message) => message.role === "assistant")
  const model = lastAssistant?.role === "assistant"
    ? api.state.provider.find((item) => item.id === lastAssistant.providerID)?.models[lastAssistant.modelID]
    : undefined
  const context = last ? last.input + last.cache_read + last.cache_write : 0
  const estimate = ForkCompaction.preview({
    context,
    delta: lastAssistant ? ForkCompaction.transcriptTokens([{ parts: parts(lastAssistant) }]) : 0,
    legacy: ForkCompaction.transcriptTokens(window.map((message) => ({ parts: parts(message) }))),
    cacheRatio: model?.cost?.input ? (model.cost.cache?.read ?? model.cost.input) / model.cost.input : 1,
  })
  const pins = ForkPins.list(sessionID)
  const limit = model?.limit.context
  const mark = (path: string) => (estimate.path === path ? "  <- used" : "")
  api.ui.dialog.replace(() => (
    <api.ui.DialogAlert
      title="Compaction preview"
      message={[
        `Context now: ${context.toLocaleString()} tokens${limit ? ` (${Math.round((context / limit) * 100)}% of ${limit.toLocaleString()})` : ""}`,
        `Messages since last compaction: ${window.length}`,
        "",
        "Compacting now would cost about (full-price input token equivalents):",
        `  replay from cache    ${estimate.cached.toLocaleString()}${mark("cached")}`,
        `  upstream transcript  ${estimate.legacy.toLocaleString()}${mark("legacy")}`,
        "",
        pins.length
          ? `Pinned: ${pins.length} message(s), copied verbatim into the summary.`
          : "Nothing pinned. Use \"Pin messages for compaction\" to keep a message verbatim.",
        "Modified files, the todo list and recent tool errors are always copied verbatim.",
      ].join("\n")}
    />
  ))
}

function toPreviewPart(part: Part) {
  if (part.type === "text" || part.type === "reasoning") return { type: part.type, text: part.text }
  if (part.type !== "tool") return { type: part.type }
  const state = part.state
  return {
    type: "tool",
    tool: part.tool,
    state: {
      status: state.status,
      input: state.input,
      output: state.status === "completed" ? state.output : undefined,
      error: state.status === "error" ? state.error : undefined,
      time: state.status === "completed" ? { compacted: state.time.compacted } : undefined,
    },
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "fork.pins",
        title: "Pin messages for compaction",
        category: "Session",
        namespace: "palette",
        run() {
          const sessionID = currentSession(api)
          if (sessionID) showPins(api, sessionID)
        },
      },
      {
        name: "fork.compaction.preview",
        title: "Compaction preview",
        category: "Session",
        namespace: "palette",
        run() {
          const sessionID = currentSession(api)
          if (sessionID) showPreview(api, sessionID)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
