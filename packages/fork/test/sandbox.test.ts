import { expect, test } from "bun:test"
import { ForkSandbox } from "../src/sandbox"

const existing = new Map<string, "dir" | "file">([
  ["/work/app", "dir"],
  ["/work", "dir"],
  ["/tmp", "dir"],
  ["/home/me/.ssh", "dir"],
  ["/home/me/.aws", "dir"],
  ["/home/me/.netrc", "file"],
  ["/home/me/cache", "dir"],
])
const stat = (target: string) => existing.get(target)
const plan = (config: Parameters<typeof ForkSandbox.args>[0]["config"], project = ["/work/app", "/work"]) =>
  ForkSandbox.args({ config, home: "/home/me", project, stat })

test("enabled follows the config, the env overrides it", () => {
  if (process.platform !== "linux") return
  expect(ForkSandbox.enabled(undefined, {})).toBe(false)
  expect(ForkSandbox.enabled({ enabled: true }, {})).toBe(true)
  expect(ForkSandbox.enabled({ enabled: false }, { OPENCODE_FORK_SANDBOX: "1" })).toBe(true)
  expect(ForkSandbox.enabled({ enabled: true }, { OPENCODE_FORK_SANDBOX: "0" })).toBe(false)
})

test("root is read-only, project and /tmp are writable, network is cut", () => {
  const out = plan({ enabled: true })
  expect(out.slice(0, 7)).toEqual(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"])
  expect(out).toContain("--unshare-all")
  expect(out).toContain("--die-with-parent")
  expect(out).not.toContain("--share-net")
  expect(out.join(" ")).toContain("--bind /work/app /work/app --bind /work /work --bind /tmp /tmp")
})

test("default read_deny hides existing paths only", () => {
  const out = plan({ enabled: true }).join(" ")
  expect(out).toContain("--tmpfs /home/me/.ssh")
  expect(out).toContain("--tmpfs /home/me/.aws")
  expect(out).not.toContain(".gnupg")
  expect(out).not.toContain("config/gh")
})

test("read_deny replaces the defaults, files are masked with /dev/null", () => {
  const out = plan({ enabled: true, read_deny: ["~/.netrc"] }).join(" ")
  expect(out).toContain("--ro-bind /dev/null /home/me/.netrc")
  expect(out).not.toContain(".ssh")
})

test("write adds paths, expands ~ and dedupes", () => {
  const out = plan({ enabled: true, write: ["~/cache", "/tmp", "/missing"] }).join(" ")
  expect(out).toContain("--bind /home/me/cache /home/me/cache")
  expect(out.match(/--bind \/tmp \/tmp/g)?.length).toBe(1)
  expect(out).not.toContain("/missing")
})

test("a non-empty network.allow keeps the network", () => {
  expect(plan({ enabled: true, network: { allow: ["github.com"] } })).toContain("--share-net")
  expect(plan({ enabled: true, network: { allow: [] } })).not.toContain("--share-net")
})

test("wrap runs the shell under bwrap", () => {
  expect(ForkSandbox.wrap(["--unshare-all"], "/bin/bash", "echo hi")).toEqual({
    command: "bwrap",
    args: ["--unshare-all", "--", "/bin/bash", "-c", "echo hi"],
  })
})

test("failureHint flags filesystem and network failures", () => {
  const hint = (output: string, networkOpen = false, exit: number | null = 1) =>
    ForkSandbox.failureHint({ exit, output, networkOpen })
  expect(hint("touch: cannot touch '/home/me/x': Read-only file system")).toContain("sandbox: false")
  expect(hint("Error: EACCES: permission denied, open '/etc/x'")).toContain("read-only or hidden")
  expect(hint("curl: (6) Could not resolve host: example.com")).toContain("network is disabled")
  expect(hint("curl: (6) Could not resolve host: example.com", true)).toBeUndefined()
  expect(hint("EROFS: read-only file system", true)).toBeDefined()
  expect(hint("Could not resolve host", false, 0)).toBeUndefined()
  expect(hint("EROFS", false, null)).toBeUndefined()
  expect(hint("test failed: expected 1 got 2")).toBeUndefined()
})
