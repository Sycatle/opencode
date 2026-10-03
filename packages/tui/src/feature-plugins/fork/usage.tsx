import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ForkBudget } from "@opencode-fork/core/budget"
import { ForkSummary } from "@opencode-fork/core/summary"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { BuiltinTuiPlugin } from "../builtins"

// Fork widgets (see docs/fork/seams.md). Data comes from the fork telemetry
// database on this machine; when the TUI is attached to a remote server there is
// none and the widgets stay hidden.

const id = "fork:usage"
// Telemetry rows are written right after each provider turn, slightly after the
// message update reaches the TUI, so the widgets poll instead of only reacting.
const REFRESH_MS = 1500

const money = (value: number) => `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`
const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))
const percent = (value: number | undefined) => (value === undefined ? "-" : `${Math.round(value * 100)}%`)

function useSummary(api: TuiPluginApi, sessionID: () => string) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), REFRESH_MS)
  onCleanup(() => clearInterval(timer))
  return createMemo(() => {
    tick()
    api.state.session.messages(sessionID()).length
    return ForkSummary.summarize(ForkTelemetry.steps(sessionID(), { children: true }), sessionID())
  })
}

function Usage(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const shares = createMemo(() => {
    const last = summary().last
    return last ? ForkSummary.shares(last.breakdown) : undefined
  })
  const limit = ForkBudget.limit()
  const level = createMemo(() => ForkSummary.budgetLevel(summary().cost, limit))

  return (
    <Show when={summary().last}>
      {(last) => (
        <box>
          <text fg={theme().text}>
            <b>Usage</b>
            <span style={{ fg: theme().textMuted }}> last turn</span>
          </text>
          <text fg={theme().textMuted}>
            {tokens(last().context)} in · cache {percent(last().cacheHit)} · {money(last().cost)}
          </text>
          <Show when={shares()}>
            {(value) => (
              <text fg={theme().textMuted}>
                sys {value().system}% tools {value().tools}% hist {value().history}% out {value().tool_output}%
              </text>
            )}
          </Show>
          <text fg={theme().textMuted}>
            {summary().turns} turns · cache {percent(summary().cacheHit)}
          </text>
          <text fg={theme().textMuted}>
            {money(summary().cost)} {summary().children.length > 0 ? "incl. subagents" : "total"}
          </text>
          <Show when={limit}>
            {(max) => (
              <text
                fg={
                  level() === "exceeded" ? theme().error : level() === "warning" ? theme().warning : theme().textMuted
                }
              >
                budget {money(summary().cost)} / {money(max())}
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

function Subagents(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const dot = (sessionID: string) =>
    props.api.state.session.status(sessionID)?.type === "busy" ? theme().warning : theme().success

  return (
    <Show when={summary().children.length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Subagents</b>
        </text>
        <For each={summary().children}>
          {(child) => (
            <box onMouseDown={() => props.api.route.navigate("session", { sessionID: child.sessionID })}>
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: dot(child.sessionID) }}>
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {ForkSummary.subagentTitle(props.api.state.session.get(child.sessionID)?.title, child.agent)}
                </text>
              </box>
              <box paddingLeft={2}>
                <text fg={theme().textMuted}>
                  {child.agent} · {ForkSummary.shortModel(child.model)} · {child.turns}t · {money(child.cost)}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function Budget(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const limit = ForkBudget.limit()
  const level = createMemo(() => ForkSummary.budgetLevel(summary().cost, limit))
  return (
    <Show when={limit}>
      {(max) => (
        <text fg={level() === "exceeded" ? theme().error : level() === "warning" ? theme().warning : theme().textMuted}>
          {money(summary().cost)}/{money(max())}
        </text>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <Usage api={api} session_id={props.session_id} />
      },
    },
  })
  api.slots.register({
    order: 160,
    slots: {
      sidebar_content(_ctx, props) {
        return <Subagents api={api} session_id={props.session_id} />
      },
    },
  })
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right(_ctx, props) {
        return <Budget api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
