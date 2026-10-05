import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { SidebarSection } from "../../component/sidebar-section"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-lsp"

// Language servers start on demand, so the block only appears once there is one to show.
function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp())
  const bad = createMemo(() => list().filter((item) => item.status !== "connected").length)

  return (
    <Show when={list().length > 0}>
      <SidebarSection
        api={props.api}
        title="LSP"
        collapsible
        defaultOpen={bad() > 0 || list().length <= 3}
        forceOpen={bad() > 0}
        summary={
          <span style={{ fg: bad() > 0 ? theme().error : theme().textMuted }}>
            {bad() > 0 ? `${bad()} error${bad() > 1 ? "s" : ""}` : `${list().length} active`}
          </span>
        }
      >
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: item.status === "connected" ? theme().success : theme().error }}>
                •
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {item.id} {Locale.truncateLeft(item.root, 24)}
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
    order: 410,
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
