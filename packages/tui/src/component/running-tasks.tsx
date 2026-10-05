import type { ToolPart } from "@opencode-ai/sdk/v2"
import { createMemo, Show } from "solid-js"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogSelect } from "../ui/dialog-select"
import type { DialogContext } from "../ui/dialog"
import { Locale } from "../util/locale"

export type RunningShell = {
  id: string
  command: string
  started: number
  background: boolean
  outputPath?: string
  output?: string
}

export type RunningAgent = {
  sessionID?: string
  title: string
  agent: string
  started: number
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

// Shells and subagents still running in a session, read from its messages: a bash call that has not
// returned, a background job that has not reported back, a task whose child session is still busy.
export function useRunningTasks(sessionID: () => string | undefined) {
  const sync = useSync()
  return createMemo(() => {
    const id = sessionID()
    if (!id) return { shells: [] as RunningShell[], agents: [] as RunningAgent[] }
    const parts = (sync.data.message[id] ?? []).flatMap((message) => sync.data.part[message.id] ?? [])
    const finished = new Set(
      parts.flatMap((part) =>
        part.type === "text" && part.synthetic ? [...part.text.matchAll(/<shell id="([^"]+)"/g)].map((m) => m[1]) : [],
      ),
    )
    const tools = parts.filter((part): part is ToolPart => part.type === "tool")

    const shells = tools.flatMap((part): RunningShell[] => {
      if (part.tool !== "bash") return []
      const command = text(part.state.input?.command) ?? ""
      if (part.state.status === "running")
        return [
          {
            id: part.callID,
            command,
            started: part.state.time.start,
            background: false,
            output: text(part.state.metadata?.output),
          },
        ]
      if (part.state.status !== "completed") return []
      const job = /Started in the background as job (\S+?)\./.exec(part.state.output)?.[1]
      if (!job || finished.has(job)) return []
      return [
        {
          id: job,
          command,
          started: part.state.time.end ?? part.state.time.start,
          background: true,
          outputPath: text(part.state.metadata?.outputPath),
        },
      ]
    })

    const agents = tools.flatMap((part): RunningAgent[] => {
      if (part.tool !== "task" || part.state.status === "pending") return []
      const child = text(part.state.metadata?.sessionId)
      const busy = child ? (sync.data.session_status[child]?.type ?? "idle") !== "idle" : false
      const running = part.state.status === "running" || (part.state.metadata?.background === true && busy)
      if (!running) return []
      return [
        {
          sessionID: child,
          title: text(part.state.input?.description) ?? "Subagent",
          agent: Locale.titlecase(text(part.state.input?.subagent_type) ?? "general"),
          started: part.state.time.start,
        },
      ]
    })

    return { shells, agents }
  })
}

const elapsed = (started: number) => Locale.duration(Math.max(0, Date.now() - started)).replace(/\.\d+s$/, "s")

// One line under the prompt: what is still running, and how to open it.
export function RunningTasksBar(props: { sessionID: string | undefined; shortcut: string; onOpen: () => void }) {
  const { theme } = useTheme()
  const running = useRunningTasks(() => props.sessionID)
  const total = () => running().shells.length + running().agents.length
  const label = () =>
    [
      running().shells.length ? `${running().shells.length} shell${running().shells.length > 1 ? "s" : ""}` : "",
      running().agents.length ? `${running().agents.length} agent${running().agents.length > 1 ? "s" : ""}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  return (
    <Show when={total() > 0}>
      <box paddingLeft={1} flexDirection="row" gap={1} onMouseUp={props.onOpen}>
        <text fg={theme.warning} wrapMode="none">
          ●
        </text>
        <text fg={theme.text} wrapMode="none">
          {label()}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {props.shortcut} to view
        </text>
      </box>
    </Show>
  )
}

export function DialogRunningTasks(props: { sessionID: string | undefined }) {
  const route = useRoute()
  const running = useRunningTasks(() => props.sessionID)
  const view = async (dialog: DialogContext, shell: RunningShell) => {
    const output = shell.outputPath
      ? await Bun.file(shell.outputPath)
          .slice(-6000)
          .text()
          .catch(() => "")
      : (shell.output ?? "")
    dialog.clear()
    await DialogAlert.show(dialog, shell.command, output.trim() || "(no output yet)")
  }
  return (
    <DialogSelect
      title="Running shells and agents"
      options={[
        ...running().shells.map((shell) => ({
          title: Locale.truncate(shell.command, 60),
          value: `shell:${shell.id}`,
          description: `${shell.background ? "background" : "running"} · ${elapsed(shell.started)}`,
          category: "Shells",
          onSelect: (dialog: DialogContext) => void view(dialog, shell),
        })),
        ...running().agents.map((agent) => ({
          title: `${agent.agent} · ${Locale.truncate(agent.title, 50)}`,
          value: `agent:${agent.sessionID ?? agent.title}`,
          description: elapsed(agent.started),
          category: "Agents",
          onSelect: (dialog: DialogContext) => {
            if (!agent.sessionID) return
            route.navigate({ type: "session", sessionID: agent.sessionID })
            dialog.clear()
          },
        })),
      ]}
    />
  )
}
