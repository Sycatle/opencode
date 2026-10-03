import { ForkFlags } from "./flags"
import path from "node:path"

// Main-session worktrees (enter_worktree / exit_worktree). Pure logic: names, paths, the merge plan and
// the per-session state. The git and instance plumbing lives in opencode (tool/fork-session-worktree.ts).

export function enabled() {
  return ForkFlags.on("SESSION_WORKTREE")
}

export interface Entry {
  name: string
  branch: string
  // Root of the git worktree.
  directory: string
  // Where the session works: the worktree counterpart of the directory it was in.
  cwd: string
  origin: { directory: string; root: string; branch: string | undefined }
}

// Process-local, like the session's runner: after a restart the session is back in its original directory
// and the worktree stays on disk (as after `keep`).
const entries = new Map<string, Entry>()

export const get = (sessionID: string) => entries.get(sessionID)
export const set = (sessionID: string, entry: Entry) => entries.set(sessionID, entry)
export const clear = (sessionID: string) => entries.delete(sessionID)

export function slug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

// Git ref names forbid: control characters, space ~ ^ : ? * [ \, "..", "@{", a leading "-" or "/", a trailing "/", "." or ".lock".
export function validBranch(branch: string) {
  if (!branch || branch === "@") return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) return false
  if (branch.includes("..") || branch.includes("@{") || branch.includes("//")) return false
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) return false
  return branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
}

export function branchFor(input: { name: string; branch?: string }) {
  return input.branch?.trim() || `opencode/${input.name}`
}

// A session that started in a subdirectory of the repository keeps working in the same subdirectory of the worktree.
export function cwdIn(origin: { directory: string; root: string }, worktree: string) {
  const relative = path.relative(origin.root, origin.directory)
  return relative.startsWith("..") || path.isAbsolute(relative) ? worktree : path.join(worktree, relative)
}

export function commitMessage(name: string, message?: string) {
  return message?.trim() || `worktree: ${name}`
}

export interface MergePlan {
  commit: boolean
  merge: boolean
  // Why the merge does not happen. The worktree and its branch are kept.
  reason?: string
}

export function mergePlan(input: {
  pending: boolean
  // Commits of the worktree branch that the origin does not have, before the pending changes are committed.
  ahead: number
  originBranch: string | undefined
  currentBranch: string | undefined
}): MergePlan {
  if (!input.originBranch)
    return {
      commit: input.pending,
      merge: false,
      reason: "the original directory was on a detached HEAD, so there is no branch to merge into",
    }
  if (input.currentBranch !== input.originBranch)
    return {
      commit: input.pending,
      merge: false,
      reason: `the original directory is now on ${input.currentBranch ?? "a detached HEAD"} instead of ${input.originBranch}`,
    }
  if (!input.pending && input.ahead === 0) return { commit: false, merge: false, reason: "the branch has no changes" }
  return { commit: input.pending, merge: true }
}

export function conflictReport(input: { branch: string; origin: string; files: string[]; error: string }) {
  return [
    `Merging ${input.branch} into ${input.origin} did not complete; the merge was aborted and nothing was changed.`,
    input.files.length
      ? `Conflicting files:\n${input.files.map((file) => `- ${file}`).join("\n")}`
      : input.error.trim(),
    `The worktree and branch ${input.branch} are kept. Resolve with \`git merge ${input.branch}\` in the original directory, or discard the worktree.`,
  ].join("\n")
}

// The assistant message path of a session: the worktree while it is inside one.
export function pathOf(sessionID: string, fallback: { cwd: string; root: string }) {
  const entry = entries.get(sessionID)
  return entry ? { cwd: entry.cwd, root: entry.directory } : fallback
}

export * as ForkSessionWorktree from "./session-worktree"
