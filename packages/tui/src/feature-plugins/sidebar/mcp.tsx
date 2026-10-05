import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { SidebarSection } from "../../component/sidebar-section"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-mcp"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const dot = (status: string) => {
    if (status === "connected") return theme().success
    if (status === "failed") return theme().error
    if (status === "disabled") return theme().textMuted
    if (status === "needs_auth") return theme().warning
    if (status === "needs_client_registration") return theme().error
    return theme().textMuted
  }

  return (
    <Show when={list().length > 0}>
      <SidebarSection
        api={props.api}
        title="MCP"
        collapsible
        defaultOpen={bad() > 0 || list().length <= 3}
        forceOpen={bad() > 0}
        summary={
          <span style={{ fg: bad() > 0 ? theme().error : theme().textMuted }}>
            {bad() > 0 ? `${bad()} error${bad() > 1 ? "s" : ""}` : `${on()}/${list().length} on`}
          </span>
        }
      >
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: dot(item.status) }}>
                •
              </text>
              <text fg={theme().text} wrapMode="word">
                {item.name}{" "}
                <span style={{ fg: theme().textMuted }}>
                  <Switch fallback={item.status}>
                    <Match when={item.status === "connected"}>connected</Match>
                    <Match when={item.status === "failed"}>
                      <i>{Locale.truncate(item.error ?? "failed", 48)}</i>
                    </Match>
                    <Match when={item.status === "disabled"}>disabled</Match>
                    <Match when={item.status === "needs_auth"}>needs auth</Match>
                    <Match when={item.status === "needs_client_registration"}>needs client ID</Match>
                  </Switch>
                </span>
              </text>
            </box>
          )}
        </For>
      </SidebarSection>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
