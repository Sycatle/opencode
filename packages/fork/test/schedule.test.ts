import { expect, test } from "bun:test"
import os from "os"
import path from "path"

// Always a fresh database: an inherited OPENCODE_FORK_DB may hold rows from earlier runs.
process.env.OPENCODE_FORK_DB = path.join(os.tmpdir(), `fork-schedule-${process.pid}-${Date.now()}.db`)
const { ForkSchedule } = await import("../src/schedule")

const at = (...parts: [number, number, number, number, number]) => new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4])
const stamp = (date: Date | undefined) => date && [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]

test("parse rejects malformed expressions", () => {
  expect(ForkSchedule.parse("* * * *").ok).toBe(false)
  expect(ForkSchedule.parse("60 * * * *").ok).toBe(false)
  expect(ForkSchedule.parse("*/0 * * * *").ok).toBe(false)
  expect(ForkSchedule.parse("5-1 * * * *").ok).toBe(false)
  expect(ForkSchedule.parse("a * * * *").ok).toBe(false)
  expect(ForkSchedule.parse("1-2-3 * * * *").ok).toBe(false)
  expect(ForkSchedule.parse("0 0 0 * *").ok).toBe(false)
  expect(ForkSchedule.parse("0 0 * * 8").ok).toBe(false)
})

test("next handles lists, ranges and steps", () => {
  expect(stamp(ForkSchedule.next("* * * * *", at(2026, 3, 10, 12, 30)))).toEqual([2026, 3, 10, 12, 31])
  expect(stamp(ForkSchedule.next("*/15 * * * *", at(2026, 3, 10, 12, 15)))).toEqual([2026, 3, 10, 12, 30])
  expect(stamp(ForkSchedule.next("10,40 9-10 * * *", at(2026, 3, 10, 9, 40)))).toEqual([2026, 3, 10, 10, 10])
  expect(stamp(ForkSchedule.next("10,40 9-10 * * *", at(2026, 3, 10, 10, 40)))).toEqual([2026, 3, 11, 9, 10])
  expect(stamp(ForkSchedule.next("0-30/10 8 * * *", at(2026, 3, 10, 8, 10)))).toEqual([2026, 3, 10, 8, 20])
  expect(stamp(ForkSchedule.next("5/20 8 * * *", at(2026, 3, 10, 8, 5)))).toEqual([2026, 3, 10, 8, 25])
  expect(stamp(ForkSchedule.next("0 0 1 1 *", at(2026, 3, 10, 0, 0)))).toEqual([2027, 1, 1, 0, 0])
})

test("next is strictly after the starting minute and ignores seconds", () => {
  const from = new Date(2026, 2, 10, 12, 30, 45)
  expect(stamp(ForkSchedule.next("30 12 * * *", from))).toEqual([2026, 3, 11, 12, 30])
  expect(stamp(ForkSchedule.next("31 12 * * *", from))).toEqual([2026, 3, 10, 12, 31])
})

test("day-of-week accepts 0 and 7 as Sunday", () => {
  // 2026-03-10 is a Tuesday, 2026-03-15 a Sunday
  expect(stamp(ForkSchedule.next("0 9 * * 0", at(2026, 3, 10, 0, 0)))).toEqual([2026, 3, 15, 9, 0])
  expect(stamp(ForkSchedule.next("0 9 * * 7", at(2026, 3, 10, 0, 0)))).toEqual([2026, 3, 15, 9, 0])
  expect(stamp(ForkSchedule.next("0 9 * * 1-5", at(2026, 3, 13, 10, 0)))).toEqual([2026, 3, 16, 9, 0])
})

test("restricted day-of-month and day-of-week combine with OR", () => {
  // the 20th OR any Monday
  expect(stamp(ForkSchedule.next("0 9 20 * 1", at(2026, 3, 10, 0, 0)))).toEqual([2026, 3, 16, 9, 0])
  expect(stamp(ForkSchedule.next("0 9 20 * 1", at(2026, 3, 17, 0, 0)))).toEqual([2026, 3, 20, 9, 0])
  // a wildcard in either field keeps AND semantics
  expect(stamp(ForkSchedule.next("0 9 20 * *", at(2026, 3, 10, 0, 0)))).toEqual([2026, 3, 20, 9, 0])
  expect(stamp(ForkSchedule.next("0 9 */10 * 1", at(2026, 3, 10, 0, 0)))).toEqual([2026, 5, 11, 9, 0])
})

test("an impossible date yields undefined", () => {
  expect(ForkSchedule.next("0 0 31 2 *", at(2026, 1, 1, 0, 0))).toBeUndefined()
})

test("next never lands on a nonexistent local time across a DST change", () => {
  // Valid for any TZ: the result must always round-trip through local wall-clock fields.
  for (const day of [8, 9, 10, 29, 30, 31]) {
    const found = ForkSchedule.next("30 2 * * *", at(2026, 3, day, 0, 0))
    expect(found).toBeDefined()
    expect(found?.getHours()).toBe(2)
    expect(found?.getMinutes()).toBe(30)
  }
})

test("due compares the next occurrence after the last run (or creation) with now", () => {
  const routine = { cron: "0 9 * * *", created: at(2026, 3, 10, 8, 0).getTime(), last_run: null }
  expect(ForkSchedule.due(routine, at(2026, 3, 10, 8, 59))).toBe(false)
  expect(ForkSchedule.due(routine, at(2026, 3, 10, 9, 0))).toBe(true)
  const ran = { ...routine, last_run: at(2026, 3, 10, 9, 0).getTime() }
  expect(ForkSchedule.due(ran, at(2026, 3, 11, 8, 59))).toBe(false)
  expect(ForkSchedule.due(ran, at(2026, 3, 13, 9, 30))).toBe(true)
})

test("argv builder targets run or auto", () => {
  expect(ForkSchedule.buildArgv({ prompt: ["fix", "tests"] })).toEqual(["run", "fix tests"])
  expect(ForkSchedule.buildArgv({ prompt: ["fix"], budget: 2 })).toEqual(["OPENCODE_FORK_BUDGET_USD=2", "run", "fix"])
  expect(ForkSchedule.buildArgv({ prompt: ["fix"], check: "bun test", budget: 2 })).toEqual([
    "auto",
    "--until",
    "bun test",
    "--budget",
    "2",
    "fix",
  ])
  expect(ForkSchedule.splitEnv(["OPENCODE_FORK_BUDGET_USD=2", "run", "A=b"])).toEqual({
    env: { OPENCODE_FORK_BUDGET_USD: "2" },
    args: ["run", "A=b"],
  })
})

test("crontab line is quoted and marked; merge and removal preserve other lines", () => {
  const line = ForkSchedule.crontabLine({ home: "/home/a b", self: ["/usr/bin/bun", "/x/index.ts"], log: "/d/schedule/tick.log" })
  expect(line).toBe(
    "* * * * * cd '/home/a b' && /usr/bin/bun /x/index.ts schedule tick >> /d/schedule/tick.log 2>&1 # opencode-fork-schedule",
  )
  const other = "MAILTO=me\n0 1 * * * backup\n"
  const merged = ForkSchedule.mergeCrontab(other, line)
  expect(merged).toBe(`${other}${line}\n`)
  expect(ForkSchedule.mergeCrontab(merged, line)).toBe(merged)
  expect(ForkSchedule.removeCrontab(merged)).toBe(other)
  expect(ForkSchedule.removeCrontab(`${line}\n`)).toBe("")
  expect(ForkSchedule.mergeCrontab("", line)).toBe(`${line}\n`)
})

test("install and uninstall go through an injected crontab and are idempotent", async () => {
  let text = "0 1 * * * backup\n"
  const writes: string[] = []
  const crontab = {
    read: async () => text,
    write: async (next: string) => {
      writes.push(next)
      text = next
    },
  }
  const line = ForkSchedule.crontabLine({ home: "/h", self: ["bun"], log: "/l" })
  expect(await ForkSchedule.install(crontab, line)).toBe(true)
  expect(await ForkSchedule.install(crontab, line)).toBe(false)
  expect(writes).toHaveLength(1)
  expect(await ForkSchedule.uninstall(crontab)).toBe(true)
  expect(await ForkSchedule.uninstall(crontab)).toBe(false)
  expect(text).toBe("0 1 * * * backup\n")
})

test("claim is exclusive until finish or until the lock goes stale", () => {
  const id = ForkSchedule.add({ cron: "* * * * *", dir: os.tmpdir(), argv: ["run", "x"] })
  expect(ForkSchedule.get(id)?.name).toBe(`routine-${id}`)
  const now = Date.now()
  expect(ForkSchedule.claim(id, now)).toBe(true)
  expect(ForkSchedule.claim(id, now + 1000)).toBe(false)
  expect(ForkSchedule.claim(id, now + ForkSchedule.STALE_MS + 1)).toBe(true)
  ForkSchedule.finish(id, 0)
  expect(ForkSchedule.get(id)).toMatchObject({ last_status: "ok", last_exit: 0, running_since: null })
  expect(ForkSchedule.claim(id)).toBe(true)
  expect(ForkSchedule.remove(id)).toBe(true)
  expect(ForkSchedule.remove(id)).toBe(false)
})

test("execute runs the command in the routine directory, logs output and records the exit", async () => {
  const dir = path.join(os.tmpdir(), `fork-schedule-run-${process.pid}-${Date.now()}`)
  const id = ForkSchedule.add({ cron: "* * * * *", dir: os.tmpdir(), argv: ["FOO=bar", "-c", "echo $FOO; pwd; exit 3"] })
  ForkSchedule.claim(id)
  const log = ForkSchedule.logPath(dir, id)
  const result = await ForkSchedule.execute(ForkSchedule.get(id)!, ["sh"], log)
  expect(result.exit).toBe(3)
  expect((await Bun.file(log).text()).split("\n")[0]).toBe("bar")
  expect(ForkSchedule.get(id)).toMatchObject({ last_status: "failed", last_exit: 3, running_since: null })
})
