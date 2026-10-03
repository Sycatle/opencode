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

export function input(data: {
  sessionID: string
  model?: { providerID: string; modelID: string }
  agent?: string
  cwd: string
}) {
  return JSON.stringify(data)
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
