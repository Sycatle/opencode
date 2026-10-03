import { afterEach, expect, test } from "bun:test"
import { ForkSessionWorktree } from "../src/session-worktree"

afterEach(() => {
  ForkSessionWorktree.clear("ses_1")
})

test("slug keeps lowercase words", () => {
  expect(ForkSessionWorktree.slug("  Fix the Login/Bug!! ")).toBe("fix-the-login-bug")
  expect(ForkSessionWorktree.slug("***")).toBe("")
})

test("branch names", () => {
  expect(ForkSessionWorktree.branchFor({ name: "a" })).toBe("opencode/a")
  expect(ForkSessionWorktree.branchFor({ name: "a", branch: " feat/x " })).toBe("feat/x")
  expect(ForkSessionWorktree.validBranch("feat/login-2")).toBe(true)
  for (const bad of ["", "-x", "a b", "a..b", "a/", "a.lock", "a/.b", "a:b", "a//b", "@", "a@{b"])
    expect(ForkSessionWorktree.validBranch(bad)).toBe(false)
})

test("cwd keeps the subdirectory", () => {
  expect(ForkSessionWorktree.cwdIn({ directory: "/r/pkg/a", root: "/r" }, "/w")).toBe("/w/pkg/a")
  expect(ForkSessionWorktree.cwdIn({ directory: "/r", root: "/r" }, "/w")).toBe("/w")
  expect(ForkSessionWorktree.cwdIn({ directory: "/elsewhere", root: "/r" }, "/w")).toBe("/w")
})

test("commit message falls back to the worktree name", () => {
  expect(ForkSessionWorktree.commitMessage("x", " fix: y ")).toBe("fix: y")
  expect(ForkSessionWorktree.commitMessage("x")).toBe("worktree: x")
})

test("merge plan", () => {
  const base = { pending: true, ahead: 0, originBranch: "main", currentBranch: "main" }
  expect(ForkSessionWorktree.mergePlan(base)).toEqual({ commit: true, merge: true })
  expect(ForkSessionWorktree.mergePlan({ ...base, pending: false, ahead: 2 })).toEqual({ commit: false, merge: true })
  expect(ForkSessionWorktree.mergePlan({ ...base, pending: false })).toMatchObject({ commit: false, merge: false })
  expect(ForkSessionWorktree.mergePlan({ ...base, originBranch: undefined })).toMatchObject({
    commit: true,
    merge: false,
  })
  expect(ForkSessionWorktree.mergePlan({ ...base, currentBranch: "dev" })).toMatchObject({ commit: true, merge: false })
})

test("conflict report names the files and keeps the branch", () => {
  const report = ForkSessionWorktree.conflictReport({ branch: "b", origin: "main", files: ["a.ts"], error: "" })
  expect(report).toContain("- a.ts")
  expect(report).toContain("kept")
})

test("session state drives the message path", () => {
  const fallback = { cwd: "/r", root: "/r" }
  expect(ForkSessionWorktree.pathOf("ses_1", fallback)).toBe(fallback)
  ForkSessionWorktree.set("ses_1", {
    name: "n",
    branch: "opencode/n",
    directory: "/w",
    cwd: "/w/p",
    origin: { directory: "/r", root: "/r", branch: "main" },
  })
  expect(ForkSessionWorktree.pathOf("ses_1", fallback)).toEqual({ cwd: "/w/p", root: "/w" })
})
