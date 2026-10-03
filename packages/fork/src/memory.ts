// Persistent per-project memory. The model sees a compact index (one line per fact) in the
// system prompt; the facts themselves are read on demand. The rendered block is snapshotted
// per session by the caller so the prompt prefix stays byte-identical between turns.
import { ForkFlags } from "./flags"
import path from "path"
import { Global } from "@opencode-ai/core/global"

export const MAX_LINES = 200
export const MAX_BYTES = 8 * 1024

export function enabled() {
  return ForkFlags.on("MEMORY")
}

export function dir(projectID: string) {
  return path.join(Global.Path.data, "memory", projectID)
}

export function permission(projectID: string): Record<string, Record<string, "allow">> {
  if (!enabled()) return {}
  return { external_directory: { [path.join(dir(projectID), "*")]: "allow" } }
}

export async function readIndex(
  memoryDir: string,
  read: (file: string) => Promise<string> = (file) => Bun.file(file).text().catch(() => ""),
) {
  return cap(await read(path.join(memoryDir, "MEMORY.md")))
}

export function cap(text: string) {
  const trimmed = text.trim()
  const lines = trimmed.split("\n")
  const kept = lines.slice(0, MAX_LINES).reduce(
    (acc, line) => {
      const bytes = acc.bytes + Buffer.byteLength(line) + 1
      return bytes > MAX_BYTES || acc.done ? { ...acc, done: true } : { bytes, done: false, lines: [...acc.lines, line] }
    },
    { bytes: 0, done: false, lines: [] as string[] },
  ).lines
  if (kept.length === lines.length) return trimmed
  return `${kept.join("\n")}\n[index truncated: ${lines.length - kept.length} more lines; keep MEMORY.md short]`
}

export function render(memoryDir: string, index: string) {
  return [
    "# Persistent memory",
    `You have a persistent, file-based memory for this project in ${memoryDir} (shared across sessions).`,
    "- Save durable facts worth recalling later: user preferences and role (type user), corrections or confirmed approaches (feedback), project decisions and context not derivable from the code (project), pointers to external resources (reference).",
    "- One fact per file `<slug>.md` with frontmatter `name`, `description`, `type` (user|feedback|project|reference), then the body. Update an existing file instead of creating a duplicate; delete facts that turn out wrong.",
    "- After saving, add or update one pointer line in MEMORY.md: `- [Title](file.md) — short hook`. MEMORY.md is only an index, never put facts in it.",
    "- Never store secrets, credentials or tokens. Do not save what the code, git history or AGENTS.md already tell.",
    "- Memories can be stale: verify against the current code before relying on one, and read a fact file only when its hook looks relevant.",
    "- This index is a snapshot taken at session start; memories saved during this session appear in the next one.",
    "",
    "## MEMORY.md",
    index || "(empty)",
  ].join("\n")
}

export * as ForkMemory from "./memory"
