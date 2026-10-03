import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ForkBudget } from "@opencode-fork/core/budget"
import { ForkQuota } from "@opencode-fork/core/quota"
import { ForkSummary } from "@opencode-fork/core/summary"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { BuiltinTuiPlugin } from "../builtins"

// Fork widgets (see docs/fork/seams.md). Data comes from the fork telemetry
// database on this machine; when the TUI is attached to a remote server there is
// none and the widgets stay hidden.

const id = "fork:usage"
// Telemetry rows are written right after each provider turn, slightly after the
// message update reaches the TUI, so the widgets poll instead of only reacting.
const REFRESH_MS = 1500
// A quota snapshot older than this no longer describes the current windows.

const money = (value: number) => `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`
const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))
const percent = (value: number | undefined) => (value === undefined ? "-" : `${Math.round(value * 100)}%`)

// One timer for every widget, and one computation per session and refresh: the sidebar and the prompt show
// several widgets for the same session, each would otherwise walk the session tree on its own.
const [tick, setTick] = createSignal(0)
let timer: ReturnType<typeof setInterval> | undefined
let users = 0
const computed = new Map<string, { key: string; value: ReturnType<typeof summarize> }>()

function useSummary(api: TuiPluginApi, sessionID: () => string) {
  users++
  timer ??= setInterval(() => setTick((value) => value + 1), REFRESH_MS)
  onCleanup(() => {
    users--
    if (users > 0 || !timer) return
    clearInterval(timer)
    timer = undefined
    computed.clear()
  })
  return createMemo(() => {
    const key = `${tick()}:${api.state.session.messages(sessionID()).length}`
    const cached = computed.get(sessionID())
    if (cached?.key === key) return cached.value
    const value = summarize(sessionID())
    computed.set(sessionID(), { key, value })
    return value
  })
}

function summarize(sessionID: string) {
  const steps = ForkTelemetry.steps(sessionID, { children: true })
  const summary = ForkSummary.summarize(steps, sessionID)
  // Only subscription responses carry quota headers, so a fresh snapshot for the
  // session's provider means the session runs on a subscription.
  const provider = steps.findLast((step) => step.session_id === sessionID)?.provider_id
  const quota = provider ? ForkQuota.fresh(provider) : undefined
  return { ...summary, quota, windowSpent: quota ? ForkQuota.windowSpent(sessionID, quota.provider) : undefined }
}

function quotaColor(api: TuiPluginApi, quota: ForkQuota.Snapshot) {
  const level = ForkSummary.quotaLevel([quota.five_hour, quota.seven_day])
  return level === "exceeded" ? api.theme.current.error : level === "warning" ? api.theme.current.warning : api.theme.current.textMuted
}

function Quota(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const window = ForkBudget.windowLimit()
  const line = (label: string, value: ForkQuota.Window | undefined) =>
    value ? `${label} ${percent(value.utilization)} · reset ${ForkSummary.formatReset(value.reset)}` : undefined
  return (
    <Show when={summary().quota}>
      {(quota) => (
        <box>
          <text fg={theme().text}>
            <b>Quota</b>
            <span style={{ fg: theme().textMuted }}> subscription</span>
          </text>
          <Show when={line("5h  ", quota().five_hour)}>
            {(text) => <text fg={quotaColor(props.api, quota())}>{text()}</text>}
          </Show>
          <Show when={line("week", quota().seven_day)}>
            {(text) => <text fg={quotaColor(props.api, quota())}>{text()}</text>}
          </Show>
          <Show when={summary().windowSpent !== undefined}>
            <text fg={theme().textMuted}>
              session +{summary().windowSpent}% of the 5h window{window ? ` / ${window}% budget` : ""}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
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
            {summary().quota ? "≈ " : ""}
            {money(summary().cost)}
            {summary().quota ? " at API prices" : ""} {summary().children.length > 0 ? "incl. subagents" : "total"}
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

const warned = new Set<string>()

function Budget(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const limit = ForkBudget.limit()
  const window = ForkBudget.windowLimit()
  const level = createMemo(() => ForkSummary.budgetLevel(summary().cost, limit))
  // The colour alone is easy to miss: say it once when the budget nears its end and once when it is spent.
  createEffect(
    on(level, (value) => {
      if (!limit || (value !== "warning" && value !== "exceeded")) return
      const key = `${props.session_id}:${value}`
      if (warned.has(key)) return
      warned.add(key)
      props.api.ui.toast({
        variant: value === "exceeded" ? "error" : "warning",
        title: value === "exceeded" ? "Budget spent" : "Budget at 80%",
        message:
          value === "exceeded"
            ? `${money(summary().cost)} of ${money(limit)}: the session wraps up without tools, then stops at 120%.`
            : `${money(summary().cost)} of ${money(limit)} spent in this session tree.`,
      })
    }),
  )
  return (
    <Show
      when={summary().quota}
      fallback={
        <Show when={limit}>
          {(max) => (
            <text
              fg={level() === "exceeded" ? theme().error : level() === "warning" ? theme().warning : theme().textMuted}
            >
              {money(summary().cost)}/{money(max())}
            </text>
          )}
        </Show>
      }
    >
      {(quota) => (
        <text fg={quotaColor(props.api, quota())}>
          5h {percent(quota().five_hour?.utilization)} · 7d {percent(quota().seven_day?.utilization)}
          {window ? ` · +${summary().windowSpent ?? 0}/${window} pts` : ""}
        </text>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 145,
    slots: {
      sidebar_content(_ctx, props) {
        return <Quota api={api} session_id={props.session_id} />
      },
    },
  })
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
