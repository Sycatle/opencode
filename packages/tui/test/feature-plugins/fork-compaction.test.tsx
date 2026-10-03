/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTuiPluginApi } from "../fixture/tui-plugin"

process.env.OPENCODE_FORK_DB ??= path.join(os.tmpdir(), `fork-tui-compaction-${process.pid}-${Date.now()}.db`)
const { ForkPins } = await import("@opencode-fork/core/pins")
const { default: plugin } = await import("../../src/feature-plugins/fork/compaction")

type Command = { name: string; run: () => void }
type Option = { title: string; footer?: string; onSelect: () => void }

const messages = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant", providerID: "anthropic", modelID: "haiku" },
]
const parts: Record<string, unknown[]> = {
  u1: [{ type: "text", text: "Always use pnpm, never npm." }],
  a1: [
    { type: "text", text: "Understood." },
    { type: "tool", tool: "read", state: { status: "completed", input: {}, output: "z".repeat(50_000), time: {} } },
  ],
}

function setup() {
  const commands: Command[] = []
  const dialogs: { kind: string; props: Record<string, unknown> }[] = []
  const base = createTuiPluginApi({
    state: {
      session: { messages: () => messages } as unknown as Partial<TuiPluginApi["state"]["session"]>,
    },
  })
  const api = {
    ...base,
    state: {
      ...base.state,
      part: (id: string) => parts[id] ?? [],
      provider: [
        {
          id: "anthropic",
          models: { haiku: { cost: { input: 1, cache: { read: 0.1 } }, limit: { context: 200_000 } } },
        },
      ],
    },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    keymap: { registerLayer: (layer: { commands: Command[] }) => commands.push(...layer.commands) },
    ui: {
      ...base.ui,
      toast: () => {},
      DialogAlert: (props: Record<string, unknown>) => dialogs.push({ kind: "alert", props }) && null,
      DialogSelect: (props: Record<string, unknown>) => dialogs.push({ kind: "select", props }) && null,
      dialog: { replace: (render: () => unknown) => render() },
    },
  } as unknown as TuiPluginApi
  return { api, commands, dialogs }
}

test("registers the pin and preview commands in the palette", async () => {
  const { api, commands } = setup()
  await plugin.tui(api, undefined, { id: plugin.id } as never)
  expect(commands.map((command) => command.name)).toEqual(["fork.pins", "fork.compaction.preview"])
})

test("preview shows both costs, the chosen path and pinned messages", async () => {
  const { api, commands, dialogs } = setup()
  await plugin.tui(api, undefined, { id: plugin.id } as never)
  ForkPins.toggle("s1", "u1", "Always use pnpm, never npm.")
  commands.find((command) => command.name === "fork.compaction.preview")!.run()
  const message = String(dialogs.at(-1)?.props.message)
  expect(message).toContain("Messages since last compaction: 2")
  expect(message).toContain("replay from cache")
  expect(message).toContain("upstream transcript")
  expect(message).toContain("<- used")
  expect(message).toContain("Pinned: 1 message(s)")
  ForkPins.toggle("s1", "u1", "")
})

test("selecting a message in the pin dialog toggles its pin", async () => {
  const { api, commands, dialogs } = setup()
  await plugin.tui(api, undefined, { id: plugin.id } as never)
  commands.find((command) => command.name === "fork.pins")!.run()
  const options = dialogs.at(-1)?.props.options as Option[]
  expect(options.map((option) => option.title)).toEqual(["Understood.", "Always use pnpm, never npm."])
  options[1].onSelect()
  expect(ForkPins.list("s1").map((pin) => pin.text)).toEqual(["Always use pnpm, never npm."])
  const refreshed = dialogs.at(-1)?.props.options as Option[]
  expect(refreshed[1].footer).toBe("pinned")
})
