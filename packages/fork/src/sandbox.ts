import path from "path"

// OS sandbox for the bash tool, built on bubblewrap (Linux only). Everything here is pure: the
// shell tool resolves the config, checks which paths exist and spawns the result.

export const DEFAULT_READ_DENY = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]

export const UNAVAILABLE_WARNING =
  "Sandbox is enabled but bubblewrap (bwrap) is not usable on this machine: bash commands run without a sandbox. Install it (apt install bubblewrap) or allow unprivileged user namespaces."

export const ESCAPE_PERMISSION = "sandbox_escape"

export const ESCAPE_PARAM_DESCRIPTION =
  "Set to false to run this command outside the OS sandbox. Always asks the user for explicit approval, so use it only after a sandboxed attempt failed because of the sandbox."

export const ESCAPE_CC_PARAM_DESCRIPTION =
  "Set to true to run this command outside the OS sandbox. Always asks the user for explicit approval, so use it only after a sandboxed attempt failed because of the sandbox."

type Config = {
  enabled?: boolean
  network?: { allow: readonly string[] }
  write?: readonly string[]
  read_deny?: readonly string[]
}

// OPENCODE_FORK_SANDBOX=1 forces the sandbox on, =0 forces it off; otherwise the config decides.
export function enabled(config: Config | undefined, env: Record<string, string | undefined> = process.env) {
  if (process.platform !== "linux") return false
  if (env.OPENCODE_FORK_SANDBOX === "1") return true
  if (env.OPENCODE_FORK_SANDBOX === "0") return false
  return config?.enabled === true
}

// bubblewrap cannot filter by domain: any allowed domain opens the whole network.
export function networkOpen(config: Config | undefined) {
  return (config?.network?.allow.length ?? 0) > 0
}

function expand(item: string, home: string, base: string) {
  if (item === "~") return home
  if (item.startsWith("~/")) return path.join(home, item.slice(2))
  return path.resolve(base, item)
}

export interface PlanInput {
  config: Config | undefined
  home: string
  // Project directory and worktree root, both writable.
  project: string[]
  // "dir" or "file" when the path exists. bwrap fails on missing bind sources and mount points.
  stat: (target: string) => "dir" | "file" | undefined
}

export function args(input: PlanInput) {
  const base = input.project[0] ?? "/"
  const writable = Array.from(
    new Set([
      ...input.project,
      "/tmp",
      ...(input.config?.write ?? []).map((item) => expand(item, input.home, base)),
    ]),
  ).filter((item) => input.stat(item) === "dir")
  const denied = Array.from(
    new Set((input.config?.read_deny ?? DEFAULT_READ_DENY).map((item) => expand(item, input.home, base))),
  ).flatMap((item) => {
    const kind = input.stat(item)
    return kind ? [{ item, kind }] : []
  })
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...writable.flatMap((item) => ["--bind", item, item]),
    // A directory is hidden behind an empty tmpfs, a file behind /dev/null.
    ...denied.flatMap((entry) =>
      entry.kind === "dir" ? ["--tmpfs", entry.item] : ["--ro-bind", "/dev/null", entry.item],
    ),
    "--unshare-all",
    ...(networkOpen(input.config) ? ["--share-net"] : []),
    "--die-with-parent",
  ]
}

// Runs `<shell> -c <command>` under bwrap. cwd and env are the caller's, bwrap keeps both.
export function wrap(bwrapArgs: string[], shell: string, command: string) {
  return { command: "bwrap", args: [...bwrapArgs, "--", shell, "-c", command] }
}

const FILESYSTEM = /read-only file system|\bEROFS\b|\bEACCES\b|permission denied/i
const NETWORK =
  /could not resolve host|temporary failure in name resolution|name or service not known|network is unreachable|\bENETUNREACH\b|\bEAI_AGAIN\b|\bENOTFOUND\b|failed to connect|unable to connect|getaddrinfo/i

// A failed command whose output looks like the sandbox's doing. Network patterns only count when the
// network is closed. Returns the line to append to the output, in the shell tool's own vocabulary.
export function failureHint(input: { exit: number | null; output: string; networkOpen: boolean }) {
  if (input.exit === 0 || input.exit === null) return undefined
  const fs = FILESYSTEM.test(input.output)
  const net = !input.networkOpen && NETWORK.test(input.output)
  if (!fs && !net) return undefined
  const what = [
    fs ? "files outside the project, /tmp and the configured write paths are read-only or hidden" : undefined,
    net ? "the network is disabled" : undefined,
  ].filter((item) => item !== undefined)
  return `[sandbox] This command may have failed because it runs in an OS sandbox (${what.join("; ")}). If it genuinely needs that access, retry it with \`sandbox: false\`; the user will be asked to approve.`
}

export * as ForkSandbox from "./sandbox"
