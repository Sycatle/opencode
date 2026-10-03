/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import plugin from "../../src/feature-plugins/fork/statusline"
import { createTuiPluginApi } from "../fixture/tui-plugin"

type Slots = Record<string, (ctx: unknown, props: unknown) => unknown>
type Handler = (event: { properties: { part: Record<string, unknown> } }) => void

function setup(statusline?: unknown, parentID?: string) {
  const registered: Slots[] = []
  const handlers: Handler[] = []
  const notified: { title?: string; message: string; notification?: unknown; sound?: unknown }[] = []
  const base = createTuiPluginApi({
    attention: {
      notify: async (input) => {
        notified.push(input)
        return { ok: true, notification: true, sound: true }
      },
    },
    state: { session: { get: () => ({ title: "Parent", parentID }), messages: () => [] } as never },
  })
  const api = {
    ...base,
    tuiConfig: { ...base.tuiConfig, statusline },
    state: { ...base.state, path: { directory: process.cwd() }, provider: [] },
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    slots: { register: (input: { slots: Slots }) => registered.push(input.slots) },
    event: { on: (_name: string, handler: Handler) => handlers.push(handler) },
  } as unknown as TuiPluginApi
  return { api, registered, handlers, notified }
}

test("renders the first line of the command output", async () => {
  const { api, registered } = setup({ command: "cat >/dev/null; printf '\\033[32mhello\\033[0m world\\nignored'" })
  await plugin.tui(api, undefined, { id: plugin.id } as never)
  const app = await testRender(() => <box>{registered[0]?.app_bottom?.({}, {}) as never}</box>, {
    width: 40,
    height: 3,
  })
  await Bun.sleep(300)
  await app.renderOnce()
  const frame = app.captureCharFrame()
  expect(frame).toContain("hello world")
  expect(frame).not.toContain("ignored")
  app.renderer.destroy()
})

test("registers nothing without a command", async () => {
  const { api, registered } = setup(undefined)
  await plugin.tui(api, undefined, { id: plugin.id } as never)
  expect(registered).toHaveLength(0)
})

test("notifies once when a background job message lands", async () => {
  const { api, handlers, notified } = setup()
  await plugin.tui(api, undefined, { id: plugin.id } as never)
  const part = (id: string, text: string, synthetic = true) => ({
    properties: { part: { id, type: "text", synthetic, sessionID: "ses_1", text } },
  })
  handlers[0]!(part("p1", '<shell id="j" state="completed" exit="0">\nout'))
  handlers[0]!(part("p1", '<shell id="j" state="completed" exit="0">\nout'))
  handlers[0]!(part("p2", '<task id="s" state="error">\nboom'))
  handlers[0]!(part("p3", '<task id="s" state="completed">', false))
  expect(notified.map((item) => item.title)).toEqual(["Background command done (exit 0)", "Subagent failed"])
  expect(notified[0]?.message).toBe("Parent")
})

test("uses the Session done attention rules, without an OS notification for subagent sessions", async () => {
  const run = async (parentID?: string) => {
    const { api, handlers, notified } = setup(undefined, parentID)
    await plugin.tui(api, undefined, { id: plugin.id } as never)
    handlers[0]!({
      properties: { part: { id: "p1", type: "text", synthetic: true, sessionID: "ses_1", text: '<shell id="j" state="completed" exit="0">\nout' } },
    })
    return notified[0]
  }
  expect(await run()).toMatchObject({ notification: { when: "blurred" }, sound: { name: "subagent_done", when: "always" } })
  expect(await run("ses_parent")).toMatchObject({ notification: false, sound: { name: "subagent_done", when: "always" } })
})
