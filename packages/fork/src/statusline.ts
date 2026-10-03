export * as ForkStatusline from "./statusline"

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

export function backgroundNotifyEnabled() {
  return process.env.OPENCODE_FORK_BACKGROUND_NOTIFY !== "0"
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
