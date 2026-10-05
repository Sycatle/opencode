import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { SidebarSection } from "../../component/sidebar-section"

const id = "internal:sidebar-todo"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const done = createMemo(() => list().filter((item) => item.status === "completed").length)
  const open = createMemo(() => list().filter((item) => item.status !== "completed"))

  return (
    <Show when={open().length > 0}>
      <SidebarSection api={props.api} title="Tasks" summary={`${done()}/${list().length}`}>
        <For each={open()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={item.status === "in_progress" ? theme().accent : theme().textMuted}>
                {item.status === "in_progress" ? "●" : "○"}
              </text>
              <text flexGrow={1} wrapMode="word" fg={item.status === "in_progress" ? theme().text : theme().textMuted}>
                {item.content}
              </text>
            </box>
          )}
        </For>
        <Show when={done() > 0}>
          <text fg={theme().textMuted}>✓ {done()} completed</text>
        </Show>
      </SidebarSection>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
