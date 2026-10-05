import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { ForkQuota } from "@opencode-fork/core/quota"
import { createMemo, Show } from "solid-js"
import { SidebarSection } from "../../component/sidebar-section"
import { compactTokens, contextGlyph, contextLevel } from "../../util/context-usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const CELLS = 20

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  // Dollars only mean something on API billing; subscription responses carry quota headers.
  const metered = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant")
    return !last || !ForkQuota.fresh(last.providerID)
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return { tokens: 0, limit: undefined, percent: null }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const limit = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]?.limit
      .context
    return { tokens, limit: limit || undefined, percent: limit ? Math.round((tokens / limit) * 100) : null }
  })

  const color = () => {
    const level = contextLevel(state().percent)
    return level === "error" ? theme().error : level === "warning" ? theme().warning : theme().text
  }
  const filled = () => Math.min(CELLS, Math.round(((state().percent ?? 0) / 100) * CELLS))

  return (
    <SidebarSection
      api={props.api}
      title="Context"
      summary={
        <Show when={state().percent !== null}>
          <span style={{ fg: color() }}>
            {contextGlyph(state().percent ?? 0)} {state().percent}%
          </span>
        </Show>
      }
    >
      <Show when={state().percent !== null}>
        <text wrapMode="none">
          <span style={{ fg: color() }}>{"█".repeat(filled())}</span>
          <span style={{ fg: theme().textMuted }}>{"░".repeat(CELLS - filled())}</span>
        </text>
      </Show>
      <text fg={theme().textMuted}>
        {compactTokens(state().tokens)}
        {state().limit ? ` / ${compactTokens(state().limit!)}` : ""} tokens
      </text>
      <Show when={metered() && cost() > 0}>
        <text fg={theme().textMuted}>{money.format(cost())} spent</text>
      </Show>
    </SidebarSection>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
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
