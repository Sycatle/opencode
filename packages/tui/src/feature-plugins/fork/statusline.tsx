import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ForkStatusline } from "@opencode-fork/core/statusline"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { BuiltinTuiPlugin } from "../builtins"

// Fork status line and background job notifications (see docs/fork/seams.md).

const id = "fork:statusline"

function sessionID(api: TuiPluginApi) {
  return api.route.current.name === "session" ? (api.route.current.params as { sessionID: string }).sessionID : undefined
}

function payload(api: TuiPluginApi, session: string) {
  const last = api.state.session
    .messages(session)
    .findLast((item): item is AssistantMessage => item.role === "assistant")
  return ForkStatusline.input({
    sessionID: session,
    model: last ? { providerID: last.providerID, modelID: last.modelID } : undefined,
    agent: last?.agent,
    cwd: api.state.path.directory,
  })
}

async function execute(command: string, cwd: string, stdin: string) {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "ignore",
    timeout: ForkStatusline.TIMEOUT_MS,
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return code === 0 ? stdout : undefined
}

function Line(props: { api: TuiPluginApi; config: ForkStatusline.Config }) {
  const dimensions = useTerminalDimensions()
  const [output, setOutput] = createSignal("")
  const session = createMemo(() => sessionID(props.api))
  let running = false
  let again = false

  const run = async () => {
    const current = session()
    if (running || !current) {
      again = again || running
      return
    }
    running = true
    const stdout = await execute(props.config.command, props.api.state.path.directory, payload(props.api, current)).catch(
      () => undefined,
    )
    running = false
    if (stdout !== undefined) setOutput(stdout)
    if (!again) return
    again = false
    void run()
  }

  createEffect(() => {
    session()
    void run()
  })
  const timer = setInterval(() => void run(), props.config.interval)
  onCleanup(() => clearInterval(timer))

  const line = createMemo(() => ForkStatusline.firstLine(output(), dimensions().width - 2))

  return (
    <Show when={line()}>
      {(text) => (
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {text()}
          </text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const config = ForkStatusline.config((api.tuiConfig as { statusline?: unknown }).statusline)
  if (config) {
    api.slots.register({
      order: 900,
      slots: {
        app_bottom() {
          return <Line api={api} config={config} />
        },
      },
    })
  }

  if (!ForkStatusline.backgroundNotifyEnabled()) return
  const seen = new Set<string>()
  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "text" || !part.synthetic || seen.has(part.id)) return
    const job = ForkStatusline.finished(part.text)
    if (!job) return
    seen.add(part.id)
    void api.attention.notify({
      title: ForkStatusline.notification(job),
      message: api.state.session.get(part.sessionID)?.title ?? "",
      notification: { when: "blurred" },
      sound: { name: job.state === "error" ? "error" : "subagent_done", when: "always" },
    })
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
