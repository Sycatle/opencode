// `opencode auto`: run the agent, then a completion check; feed failures back into
// the same session until the check passes, the budget is spent, or iterations run out.

const MAX_CHECK_OUTPUT = 4000

export type Check = { code: number; output: string }

export type Decision =
  | { action: "done"; reason: "check-passed" }
  | { action: "stop"; reason: "budget" | "iterations" | "no-session" }
  | { action: "continue"; prompt: string }

export function decide(input: {
  check: Check | undefined
  sessionID: string | undefined
  command: string
  iteration: number
  maxIterations: number
  spent: number
  budget: number | undefined
}): Decision {
  if (!input.sessionID) return { action: "stop", reason: "no-session" }
  if (input.check?.code === 0) return { action: "done", reason: "check-passed" }
  if (input.budget !== undefined && input.spent >= input.budget) return { action: "stop", reason: "budget" }
  if (input.iteration >= input.maxIterations) return { action: "stop", reason: "iterations" }
  return { action: "continue", prompt: followUp(input.command, input.check) }
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
