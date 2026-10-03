export * as ForkStatusline from "./statusline"
import { ForkFlags } from "./flags"

export const INTERVAL_DEFAULT = 5000
export const INTERVAL_MIN = 1000
export const TIMEOUT_MS = 2000

export type Config = { command: string; interval: number }

export function config(raw: unknown): Config | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const command = "command" in raw && typeof raw.command === "string" ? raw.command.trim() : ""
  if (!command) return undefined
  const interval = "interval" in raw && typeof raw.interval === "number" ? raw.interval : INTERVAL_DEFAULT
  return { command, interval: Math.max(INTERVAL_MIN, interval) }
}

export type Quota = {
  five_hour?: { utilization: number; reset: number }
  seven_day?: { utilization: number; reset: number }
  status: string
}

export function input(data: {
  sessionID: string
  // Messaging name of the session (see ForkMessaging), when it is registered.
  name?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  cwd: string
  quota?: Quota
  // Pending in-session wakeup (see ForkWakeup): due time in ms, its reason, and whether it repeats.
  wakeup?: { due: number; reason?: string; repeat: boolean }
}) {
  return JSON.stringify(data)
}

// Subscription quota for the status line command: utilization 0-1, reset in ms.
export function quota(snapshot: Quota | undefined): Quota | undefined {
  if (!snapshot) return undefined
  const window = (value: Quota["five_hour"]) => value && { utilization: value.utilization, reset: value.reset }
  return { five_hour: window(snapshot.five_hour), seven_day: window(snapshot.seven_day), status: snapshot.status }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function firstLine(stdout: string, width: number) {
  const line =
    stdout
      .replace(ANSI, "")
      .split(/\r?\n/)
      .find((item) => item.trim()) ?? ""
  return Array.from(line.replace(/[\u0000-\u001f\u007f]/g, "").trimEnd())
    .slice(0, Math.max(0, width))
    .join("")
}

// The built-in line shown when no `statusline.command` is configured: what the fork decided on its own that the
// prompt area does not show (the model the Router picked, a pending wakeup). Empty when there is nothing to say.
export function builtin(
  data: {
    route?: { model_id: string; tier: string; kind: string }
    wakeup?: { due: number; reason?: string; repeat: boolean }
    // Auto-mode verdicts of the session (see ForkClassifier.decisions): approvals happen silently otherwise.
    auto?: readonly { decision: string }[]
    // The last smart compaction decision: shown only when a compaction was due by size but held back.
    compaction?: { code: string }
    // End of a Jev pause (see ForkJev.pausedUntil): every Jev feature runs on its fallback until then.
    jevPausedUntil?: number
  },
  now = Date.now(),
) {
  const route =
    data.route &&
    `router → ${data.route.model_id} · ${data.route.tier}${data.route.kind === "decision" ? "" : ` (${data.route.kind})`}`
  const wakeup =
    data.wakeup &&
    [
      `${data.wakeup.repeat ? "loop" : "wakeup"} ${data.wakeup.due <= now ? "due" : `in ${duration(data.wakeup.due - now)}`}`,
      data.wakeup.reason ? `: ${data.wakeup.reason}` : "",
    ].join("")
  const approved = data.auto?.filter((row) => row.decision === "allow").length ?? 0
  const asked = (data.auto?.length ?? 0) - approved
  const auto = data.auto?.length ? `auto: ${approved} approved${asked ? `, ${asked} asked` : ""}` : undefined
  const compaction = data.compaction && DEFERRED[data.compaction.code]
  const jev = data.jevPausedUntil && `Jev failing, paused for ${duration(data.jevPausedUntil - now)}`
  return [route, auto, compaction, jev, wakeup].filter((part): part is string => !!part).join("  ·  ")
}

const DEFERRED: Record<string, string> = {
  "not-boundary": "compaction deferred: task not over",
  "not-worth": "compaction deferred: not worth it yet",
}

function duration(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.ceil(ms / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`
}

export function backgroundNotifyEnabled() {
  return ForkFlags.on("BACKGROUND_NOTIFY")
}

export type Finished = { kind: "task" | "shell"; state: "completed" | "error"; exit?: number }

export function finished(text: string): Finished | undefined {
  const match = /^<(task|shell) [^>\n]*?state="(completed|error)"[^>\n]*>/.exec(text)
  if (!match) return undefined
  const exit = /\bexit="(-?\d+)"/.exec(match[0])
  return {
    kind: match[1] === "task" ? "task" : "shell",
    state: match[2] === "error" ? "error" : "completed",
    ...(exit ? { exit: Number(exit[1]) } : {}),
  }
}

export function notification(job: Finished) {
  const subject = job.kind === "task" ? "Subagent" : "Background command"
  const title = `${subject} ${job.state === "error" ? "failed" : "done"}`
  return job.exit === undefined ? title : `${title} (exit ${job.exit})`
}
