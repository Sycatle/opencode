import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useCommandShortcut } from "../keymap"
import { compactTokens, estimateTokens } from "../util/context-usage"
import { Spinner } from "./spinner"

// 42s, 3m 07s, 1h 05m 09s: a running clock, so seconds always tick.
function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

const TOOL_VERBS: Record<string, string> = {
  bash: "Running",
  read: "Reading",
  glob: "Searching",
  grep: "Searching",
  edit: "Editing",
  write: "Writing",
  apply_patch: "Editing",
  webfetch: "Browsing",
  websearch: "Searching the web",
  task: "Delegating",
  todowrite: "Planning",
  question: "Asking",
  skill: "Loading a skill",
}

// Pinned above the prompt while a turn runs: "Working... (3m 07s · ↓ 13.3k tokens · esc to interrupt)".
// The verb follows what the turn is doing, and the line takes the color of the agent (build, plan...).
export function WorkingLine(props: { sessionID: string; interrupt: number; color: RGBA; agent?: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const interruptShortcut = useCommandShortcut("session.interrupt")
  const [now, setNow] = createSignal(Date.now())
  const [dots, setDots] = createSignal(1)
  const clockTimer = setInterval(() => setNow(Date.now()), 1000)
  const dotsTimer = setInterval(() => setDots((value) => (value % 3) + 1), 400)
  onCleanup(() => {
    clearInterval(clockTimer)
    clearInterval(dotsTimer)
  })
  const busy = createMemo(() => (sync.data.session_status[props.sessionID]?.type ?? "idle") !== "idle")
  const verb = createMemo(() => {
    if (sync.data.session_status[props.sessionID]?.type === "retry") return "Retrying"
    const messages = sync.data.message[props.sessionID] ?? []
    const last = messages.findLast((x) => x.role === "assistant")
    const part = last ? sync.data.part[last.id]?.at(-1) : undefined
    if (part?.type === "reasoning" && !part.time.end) return "Thinking"
    if (part?.type === "text" && !part.time?.end) return "Writing"
    if (part?.type === "tool" && (part.state.status === "running" || part.state.status === "pending"))
      return TOOL_VERBS[part.tool] ?? "Working"
    return props.agent === "plan" ? "Planning" : "Working"
  })
  // Output tokens produced during this turn. Providers report them when a step ends, so a step still
  // streaming is estimated from the text received so far and the figure is marked with "~".
  const turn = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const index = messages.findLastIndex((x) => x.role === "user")
    if (index < 0) return
    let estimated = false
    const output = messages.slice(index + 1).reduce((sum, x) => {
      if (x.role !== "assistant") return sum
      const reported = x.tokens.output + x.tokens.reasoning
      if (reported > 0 || x.time.completed) return sum + reported
      estimated = true
      return (
        sum +
        (sync.data.part[x.id] ?? []).reduce(
          (total, part) =>
            total +
            (part.type === "text" || part.type === "reasoning"
              ? estimateTokens(part.text)
              : part.type === "tool"
                ? estimateTokens(JSON.stringify(part.state.input ?? {}))
                : 0),
          0,
        )
      )
    }, 0)
    return { started: messages[index].time.created, output, estimated }
  })
  return (
    <Show when={busy() && turn()}>
      {(item) => (
        <box marginBottom={1}>
          <Spinner color={props.color}>
            {`${verb()}${".".repeat(dots()).padEnd(3)} `}
            <span style={{ fg: theme.textMuted }}>
              {`(${clock(now() - item().started)}`}
              {item().output ? ` · ↓ ${item().estimated ? "~" : ""}${compactTokens(item().output)} tokens` : ""}
              {" · "}
              <span style={{ fg: props.interrupt > 0 ? theme.primary : theme.textMuted }}>
                {`${interruptShortcut()} ${props.interrupt > 0 ? "again to interrupt" : "to interrupt"}`}
              </span>
              {")"}
            </span>
          </Spinner>
        </box>
      )}
    </Show>
  )
}
