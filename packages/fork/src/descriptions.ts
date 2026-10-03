// Compact tool descriptions. Tool definitions are resent on every provider turn,
// so upstream's long prose (examples, repeated warnings) costs tokens on each step.
// Each replacement keeps every rule and every runtime value of the original; when a
// runtime value cannot be extracted, the original description is kept.

export function enabled() {
  return process.env.OPENCODE_FORK_SLIM_TOOLS !== "0"
}

export function slim(toolID: string, description: string) {
  if (!enabled()) return description
  const replace = SLIM[toolID]
  return replace ? (replace(description) ?? description) : description
}

const STATIC: Record<string, string> = {
  task: [
    "Launch a subagent to handle a multistep task autonomously; set subagent_type.",
    "- Not for a known file path, a specific symbol or 2-3 known files: use Read, Glob or Grep.",
    "- Launch independent agents in parallel (several calls in one message); never redo delegated work.",
    "- A new agent starts with no context (task_id resumes a previous one): give a complete prompt, say whether to write code or only research, how to verify, and exactly what to return.",
    "- Its final message is not shown to the user: summarize it. Trust its results.",
    "- Use agents described as proactive without being asked.",
  ].join("\n"),
  todowrite: [
    "Maintain the task list for multi-step work (3+ steps, several user requests, or when asked). Skip it for a single or trivial task and for pure questions.",
    "States: pending, in_progress (exactly one at a time), completed, cancelled.",
    "Update in real time. Mark completed only when done and verified. If blocked, keep in_progress and add a follow-up todo. Keep user-provided commands verbatim. Items must be specific and actionable.",
  ].join("\n"),
  edit: [
    "Replace an exact string in a file. Read the file first in this conversation.",
    "- oldString must match exactly, with the indentation that follows the `N: ` prefix of Read output (never include the prefix), and be unique; otherwise add context or set replaceAll (also for renames).",
    "- Prefer editing existing files over creating new ones. No emojis unless asked.",
  ].join("\n"),
  read: [
    "Read a file or directory by absolute path. Returns up to 2000 lines as `N: content` (offset is 1-indexed to continue); lines over 2000 characters are truncated; directories list one entry per line, `/` for subdirectories.",
    "Use Grep for large files and Glob when unsure of a path. Read several files in parallel and avoid small repeated slices. Images and PDFs are returned as attachments.",
  ].join("\n"),
  write: [
    "Write a file, overwriting any existing one. Read an existing file first.",
    "Prefer editing existing files; create new files, documentation or README files only when required or asked. No emojis unless asked.",
  ].join("\n"),
  grep: [
    "Search file contents with a regular expression; filter files with include (e.g. \"*.{ts,tsx}\"). Returns paths, line numbers and matching lines.",
    "To count matches, run `rg` with Bash (not grep). For open-ended multi-round searches, use Task.",
  ].join("\n"),
  glob: [
    "Find files by glob pattern (e.g. \"src/**/*.ts\"). Returns matching paths.",
    "Batch several searches in one message. For open-ended multi-round searches, use Task.",
  ].join("\n"),
  webfetch: [
    "Fetch a full URL (HTTP is upgraded to HTTPS) and return it as markdown (default), text or html. Read-only; large content may be summarized.",
    "Prefer a more capable or targeted web tool when one is available.",
  ].join("\n"),
  skill:
    "Load a skill listed in the system prompt when the task matches it; its instructions and resource paths are added to the conversation.",
}

const SLIM: Record<string, (original: string) => string | undefined> = {
  ...Object.fromEntries(
    Object.entries(STATIC).map(([id, text]) => [
      id,
      (original: string) => (id === "task" ? withBackground(text, original) : text),
    ]),
  ),
  bash: slimShell,
}

// The background section is only present when background subagents are enabled.
function withBackground(text: string, original: string) {
  const marker = original.indexOf("Background mode:")
  return marker === -1 ? text : `${text}\n\n${original.slice(marker)}`
}

// Only the POSIX shell profile is rewritten; cmd.exe and PowerShell keep upstream text.
function slimShell(original: string) {
  const env = original.match(/OS: (\S+), Shell: (\S+)/)
  const tmp = original.match(/Use `([^`]+)` for temporary work/)
  const timeout = original.match(/commands will time out after (\d+)ms/)
  const limits = original.match(/exceeds (\d+) lines or (\d+) bytes/)
  if (!env || !tmp || !timeout || !limits) return undefined
  if (!["bash", "zsh", "sh", "fish", "dash", "ksh"].includes(env[2])) return undefined
  return [
    `Run a shell command (OS: ${env[1]}, shell: ${env[2]}) for terminal work: git, package managers, builds, tests. Never for files: use Read, Write, Edit, Glob and Grep instead of cat/head/tail/sed/awk/echo/find/grep.`,
    "- Set workdir instead of `cd`. Quote paths containing spaces. Check that a parent directory exists before creating into it.",
    `- Timeout defaults to ${timeout[1]}ms. Output over ${limits[1]} lines or ${limits[2]} bytes is truncated and saved to a file: Read it with offset or Grep it; do not pipe into head/tail.`,
    "- Independent commands: parallel tool calls in one message. Dependent ones: one call chained with &&; use ; only when earlier failures do not matter. No newlines between commands.",
    `- Temporary files go in \`${tmp[1]}\` (exists, pre-approved).`,
    "- Git: commit, amend, push or open PRs only when asked. Inspect status, diff and recent log first; stage only intended files, never secrets; match the repo's message style. Never change git config, skip hooks, use -i, force-push or make empty commits unless asked. If a hook rejects a commit, fix it and make a new commit. Before a PR, review every commit against the base branch. Use `gh` for GitHub and return the PR URL.",
  ].join("\n")
}

export * as ForkDescriptions from "./descriptions"
