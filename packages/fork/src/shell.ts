import { ForkAgents } from "./agents"

// Background shell commands are on unless OPENCODE_FORK_BACKGROUND_SHELL=0.
export function enabled() {
  return process.env.OPENCODE_FORK_BACKGROUND_SHELL !== "0"
}

export const JOB_TYPE = "shell"

export const TAIL_LINES = 20

export function atCap(running: number) {
  return running >= ForkAgents.maxBackground()
}

export function capMessage(running: number) {
  return `${running} background shell commands are already running (limit ${ForkAgents.maxBackground()}). Stop one with shell_kill or wait for one to finish.`
}

export function tail(text: string, lines: number) {
  const all = text.replace(/\n$/, "").split("\n")
  return all.slice(Math.max(0, all.length - lines)).join("\n")
}

// A job output is `exit=<code>` followed by the output tail, so the exit code
// survives in the generic BackgroundJob record.
export function result(code: number | null, text: string) {
  return `exit=${code ?? "none"}\n${text}`
}

export function parseResult(output: string) {
  const [first = "", ...rest] = output.split("\n")
  const code = Number(first.replace("exit=", ""))
  return { exit: first === "exit=none" || Number.isNaN(code) ? null : code, tail: rest.join("\n") }
}

export function renderMessage(input: {
  id: string
  state: "completed" | "error"
  exit: number | null
  tail: string
  outputPath: string
}) {
  return [
    `<shell id="${input.id}" state="${input.state}"${input.exit === null ? "" : ` exit="${input.exit}"`}>`,
    `Background shell command finished. Full output: ${input.outputPath}`,
    tail(input.tail, TAIL_LINES),
    "</shell>",
  ].join("\n")
}

export function startedMessage(input: { id: string; outputPath: string }) {
  return [
    `Started in the background as job ${input.id}.`,
    `Output file: ${input.outputPath}`,
    `Read recent output with shell_output (id: "${input.id}"), stop it with shell_kill (id: "${input.id}").`,
    "You will be notified automatically when it exits. Do not poll or sleep waiting for it.",
  ].join("\n")
}

export const BACKGROUND_PARAM_DESCRIPTION =
  "Run the command in the background and return immediately with a job id. Use for dev servers, watchers and long test runs. Read output with shell_output, stop with shell_kill; you are notified when it exits."

export * as ForkShell from "./shell"
