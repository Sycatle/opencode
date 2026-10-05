import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ForkBudget } from "@opencode-fork/core/budget"
import { ForkQuota } from "@opencode-fork/core/quota"
import { ForkSummary } from "@opencode-fork/core/summary"
import { ForkTelemetry } from "@opencode-fork/core/telemetry"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { BuiltinTuiPlugin } from "../builtins"
import { SidebarSection } from "../../component/sidebar-section"

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

const CELLS = 8
const locale = () => ForkSummary.systemLocale()

// A quota window as a bar with a marker where usage would sit if it kept pace with the clock,
// colored by whether usage is on track to last until the reset.
function QuotaBar(props: { api: TuiPluginApi; pace: ReturnType<typeof ForkSummary.quotaPace>; utilization: number }) {
  const theme = () => props.api.theme.current
  const color = () =>
    props.pace.level === "error" ? theme().error : props.pace.level === "warning" ? theme().warning : theme().text
  const filled = () => Math.min(CELLS, Math.round(props.utilization * CELLS))
  const marker = () => Math.min(CELLS, Math.round(props.pace.elapsed * CELLS))
  const cells = () =>
    Array.from({ length: CELLS + 1 }, (_, index) => ({
      marker: index === marker(),
      cell: index < CELLS ? (index < filled() ? "█" : "░") : "",
      filled: index < filled(),
    }))
  return (
    <For each={cells()}>
      {(item) => (
        <>
          <Show when={item.marker}>
            <span style={{ fg: theme().textMuted }}>│</span>
          </Show>
          <span style={{ fg: item.filled ? color() : theme().textMuted }}>{item.cell}</span>
        </>
      )}
    </For>
  )
}

function paceColor(api: TuiPluginApi, level: "ok" | "warning" | "error") {
  return level === "error"
    ? api.theme.current.error
    : level === "warning"
      ? api.theme.current.warning
      : api.theme.current.textMuted
}

function Quota(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const window = ForkBudget.windowLimit()
  return (
    <Show when={summary().quota}>
      {(quota) => (
        <SidebarSection api={props.api} title="Limits" summary="subscription">
          <For
            each={[
              { label: "5h", window: quota().five_hour, length: ForkSummary.FIVE_HOUR },
              { label: "7d", window: quota().seven_day, length: ForkSummary.SEVEN_DAY },
            ]}
          >
            {(item) => (
              <Show when={item.window}>
                {(window) => {
                  const pace = createMemo(() => ForkSummary.quotaPace(window(), item.length))
                  const forecast = createMemo(() =>
                    ForkSummary.quotaForecast(item.label as "5h" | "7d", pace(), window().reset, {
                      locale: locale(),
                    }),
                  )
                  return (
                    <box paddingBottom={1}>
                      <text wrapMode="none">
                        <span style={{ fg: theme().text }}>
                          <b>{ForkSummary.windowLabel(item.label as "5h" | "7d", locale()).padEnd(3)}</b>
                        </span>{" "}
                        <QuotaBar api={props.api} pace={pace()} utilization={window().utilization} />{" "}
                        <span style={{ fg: paceColor(props.api, pace().level) }}>{percent(window().utilization)}</span>
                      </text>
                      <text fg={theme().textMuted} wrapMode="none">
                        {ForkSummary.resetAt(window().reset, Date.now(), locale())}
                      </text>
                      <Show when={forecast()}>
                        {(text) => (
                          <text
                            fg={pace().exhaustAt ? paceColor(props.api, pace().level) : theme().textMuted}
                            wrapMode="word"
                          >
                            {pace().exhaustAt ? "⚠ " : ""}
                            {text()}
                          </text>
                        )}
                      </Show>
                    </box>
                  )
                }}
              </Show>
            )}
          </For>
          <text fg={theme().textMuted}>{ForkSummary.paceLegend(locale())}</text>
          <Show when={summary().windowSpent !== undefined}>
            <text fg={theme().textMuted}>
              session +{summary().windowSpent}% of the 5h window{window ? ` / ${window}% budget` : ""}
            </text>
          </Show>
        </SidebarSection>
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
        <SidebarSection
          api={props.api}
          title="Last turn"
          collapsible
          defaultOpen={false}
          summary={`${tokens(last().context)} in · cache ${percent(last().cacheHit)}`}
        >
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
          <Show when={!summary().quota}>
            <text fg={theme().textMuted}>
              {money(last().cost)} this turn · {money(summary().cost)}{" "}
              {summary().children.length > 0 ? "incl. subagents" : "total"}
            </text>
          </Show>
          <Show when={summary().quota ? undefined : limit}>
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
        </SidebarSection>
      )}
    </Show>
  )
}

function Subagents(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const summary = useSummary(props.api, () => props.session_id)
  const running = (sessionID: string) => props.api.state.session.status(sessionID)?.type === "busy"
  const active = createMemo(() => summary().children.filter((child) => running(child.sessionID)).length)

  return (
    <Show when={summary().children.length > 0}>
      <SidebarSection
        api={props.api}
        title="Subagents"
        summary={active() > 0 ? `${active()} running` : String(summary().children.length)}
      >
        <For each={summary().children}>
          {(child) => (
            <box onMouseDown={() => props.api.route.navigate("session", { sessionID: child.sessionID })}>
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: running(child.sessionID) ? theme().warning : theme().success }}>
                  {running(child.sessionID) ? "●" : "✓"}
                </text>
                <text fg={theme().text} wrapMode="word">
                  {ForkSummary.subagentTitle(props.api.state.session.get(child.sessionID)?.title, child.agent)}
                </text>
              </box>
              <box paddingLeft={2}>
                <text fg={theme().textMuted}>
                  {child.agent} · {ForkSummary.shortModel(child.model)} · {child.turns}t
                  {summary().quota ? "" : ` · ${money(child.cost)}`}
                </text>
              </box>
            </box>
          )}
        </For>
      </SidebarSection>
    </Show>
  )
}

const warned = new Set<string>()

function Budget(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const dimensions = useTerminalDimensions()
  // The reset countdown only appears when the status row has room next to the model and the shortcuts.
  const narrow = () => dimensions().width < 150
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
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For
            each={[
              { label: "5h", window: quota().five_hour, length: ForkSummary.FIVE_HOUR },
              { label: "7d", window: quota().seven_day, length: ForkSummary.SEVEN_DAY },
            ]}
          >
            {(item) => (
              <Show when={item.window}>
                {(window) => {
                  const pace = createMemo(() => ForkSummary.quotaPace(window(), item.length))
                  // Detail only when it matters: above half the window, or when the pace is off.
                  const detail = () => !narrow() && (window().utilization >= 0.5 || pace().level !== "ok")
                  return (
                    <text wrapMode="none">
                      <span style={{ fg: theme().textMuted }}>
                        {ForkSummary.windowLabel(item.label as "5h" | "7d", locale())}{" "}
                      </span>
                      <QuotaBar api={props.api} pace={pace()} utilization={window().utilization} />
                      <span style={{ fg: paceColor(props.api, pace().level) }}> {percent(window().utilization)}</span>
                      <Show when={detail()}>
                        <span style={{ fg: theme().textMuted }}>
                          {" "}
                          · {ForkSummary.resetIn(window().reset, Date.now(), locale())}
                        </span>
                      </Show>
                    </text>
                  )
                }}
              </Show>
            )}
          </For>
          <Show when={window}>
            <text fg={theme().textMuted} wrapMode="none">
              +{summary().windowSpent ?? 0}/{window} pts
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  // Attached to a server on another machine: this machine's fork.db knows nothing of its sessions.
  if (process.env.OPENCODE_FORK_REMOTE === "1") {
    api.slots.register({
      order: 150,
      slots: {
        sidebar_content() {
          return <text fg={api.theme.current.textMuted}>Fork usage: not available on a remote server</text>
        },
      },
    })
    return
  }
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return <Quota api={api} session_id={props.session_id} />
      },
    },
  })
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content(_ctx, props) {
        return <Usage api={api} session_id={props.session_id} />
      },
    },
  })
  api.slots.register({
    order: 210,
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
