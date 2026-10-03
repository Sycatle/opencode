// `opencode auto`: run the agent, then a completion check; feed failures back into
// the same session until the check passes, the budget is spent, or iterations run out.
// Without a check command, Jev judges from the task and the agent's last message whether it is done.

import type { ForkJev } from "./jev"

const MAX_CHECK_OUTPUT = 4000

export type Check = { code: number; output: string }

export type Judgement = { status: "done" | "partial" | "blocked"; confidence: number; verified: number }

export type Decision =
  | { action: "done"; reason: "check-passed" | "judged-complete" }
  | { action: "stop"; reason: "budget" | "iterations" | "no-session" | "blocked" | "judge-unavailable" }
  | { action: "continue"; prompt: string }

// With a `command`, its check decides and `judged` is ignored. Without one, `judged` is Jev's verdict, or
// "unavailable" when Jev could not answer: never a blind loop.
export function decide(input: {
  check: Check | undefined
  judged?: Judgement | "unavailable"
  sessionID: string | undefined
  command: string | undefined
  iteration: number
  maxIterations: number
  spent: number
  budget: number | undefined
}): Decision {
  if (!input.sessionID) return { action: "stop", reason: "no-session" }
  if (input.command === undefined) {
    if (input.judged === undefined || input.judged === "unavailable") return { action: "stop", reason: "judge-unavailable" }
    if (input.judged.status === "done" && input.judged.confidence >= 0.8 && input.judged.verified >= 0.5)
      return { action: "done", reason: "judged-complete" }
    if (input.judged.status === "blocked" && input.judged.confidence >= 0.7) return { action: "stop", reason: "blocked" }
  }
  if (input.command !== undefined && input.check?.code === 0) return { action: "done", reason: "check-passed" }
  if (input.budget !== undefined && input.spent >= input.budget) return { action: "stop", reason: "budget" }
  if (input.iteration >= input.maxIterations) return { action: "stop", reason: "iterations" }
  return { action: "continue", prompt: input.command === undefined ? JUDGED_FOLLOW_UP : followUp(input.command, input.check) }
}

const JUDGED_FOLLOW_UP =
  "The task is not complete yet. Finish the remaining work, verify it (run the tests or the build when there are any), then stop."

const JUDGE_TASK_CHARS = 2000
const JUDGE_REPLY_CHARS = 2500

export function judgeRequest(input: { task: string; reply: string }) {
  return {
    state: [
      "A coding agent was given a task and has stopped. Decide whether the task is complete.",
      `Task:\n${input.task.slice(0, JUDGE_TASK_CHARS)}`,
      `The agent's last message:\n${input.reply.slice(-JUDGE_REPLY_CHARS)}`,
    ].join("\n\n"),
    questions: {
      status: {
        type: "choice",
        instructions: "Is the task as stated fully done?",
        criteria: {
          done: "The task as stated is fully done",
          partial: "Work remains",
          blocked: "The agent cannot continue without the user",
        },
      },
      verified: {
        type: "noul",
        instructions: "The agent verified its result (ran the tests, the build or other checks)",
      },
    } satisfies Record<string, ForkJev.Question>,
  }
}

export function judgement(answers: Record<string, ForkJev.Answer> | undefined): Judgement | undefined {
  const status = answers?.status
  const verified = answers?.verified?.noul
  if (!status || verified === undefined) return undefined
  if (status.choice !== "done" && status.choice !== "partial" && status.choice !== "blocked") return undefined
  return { status: status.choice, confidence: status.confidence ?? 0.5, verified }
}

export function followUp(command: string, check: Check | undefined) {
  const output = check?.output.trim() ?? ""
  return [
    `The completion check \`${command}\` failed${check ? ` (exit code ${check.code})` : ""}.`,
    output
      ? `Output (last ${MAX_CHECK_OUTPUT} characters):\n\`\`\`\n${output.slice(-MAX_CHECK_OUTPUT)}\n\`\`\``
      : "It produced no output.",
    "Fix the cause, verify your fix, then stop. Do not modify the check itself.",
  ].join("\n\n")
}

// "20%" is a subscription budget in points of the 5-hour window; a number is USD.
export function parseBudget(value: string | undefined) {
  if (!value) return undefined
  const trimmed = value.trim()
  const amount = Number(trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed.replace(/^\$/, ""))
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid budget "${value}": use 0.5 (USD) or 20% (5-hour window)`)
  return trimmed.endsWith("%") ? { unit: "window" as const, amount } : { unit: "usd" as const, amount }
}

// Arguments to re-invoke the current opencode entrypoint (dev script with its runtime flags, or compiled binary).
export function selfCommand(execPath: string, argv: readonly string[], execArgv: readonly string[] = []) {
  const script = argv[1]
  return script && /\.(ts|js|mjs)$/.test(script) && !script.startsWith("/$bunfs") ? [execPath, ...execArgv, script] : [execPath]
}

export * as ForkAutonomy from "./autonomy"
