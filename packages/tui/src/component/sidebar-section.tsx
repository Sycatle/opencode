import { createEffect, createSignal, Show, type JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

// A titled sidebar block: bold title, a muted summary on the right and, optionally, a toggle.
// `forceOpen` reopens a collapsed block when something in it needs attention (an error, say).
export function SidebarSection(props: {
  api: TuiPluginApi
  title: string
  summary?: JSX.Element
  collapsible?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  children: JSX.Element
}) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(props.defaultOpen ?? true)
  createEffect(() => {
    if (props.forceOpen) setOpen(true)
  })
  const expanded = () => !props.collapsible || open()
  return (
    <box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        onMouseDown={() => props.collapsible && setOpen((value) => !value)}
      >
        <text fg={theme().text} wrapMode="none">
          <b>
            {props.collapsible ? (open() ? "▾ " : "▸ ") : ""}
            {props.title}
          </b>
        </text>
        <Show when={props.summary}>
          <text fg={theme().textMuted} wrapMode="none">
            {props.summary}
          </text>
        </Show>
      </box>
      <Show when={expanded()}>
        <box paddingLeft={props.collapsible ? 2 : 0}>{props.children}</box>
      </Show>
    </box>
  )
}
