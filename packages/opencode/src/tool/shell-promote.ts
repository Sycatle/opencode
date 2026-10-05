// FORK-SEAM: background-shell
// Foreground shell commands that can still be moved to the background, by session. The shell tool
// registers each running command here; the experimental `session.background` endpoint (ctrl+b in the TUI)
// asks the session's commands to detach and keep running as background jobs.

const waiting = new Map<string, Set<() => void>>()

export function register(sessionID: string, promote: () => void) {
  const set = waiting.get(sessionID) ?? new Set<() => void>()
  set.add(promote)
  waiting.set(sessionID, set)
  return () => {
    set.delete(promote)
    if (set.size === 0 && waiting.get(sessionID) === set) waiting.delete(sessionID)
  }
}

// Returns how many running commands were asked to detach.
export function request(sessionID: string) {
  const set = waiting.get(sessionID)
  if (!set) return 0
  const all = [...set]
  all.forEach((promote) => promote())
  return all.length
}

export * as ShellPromote from "./shell-promote"
