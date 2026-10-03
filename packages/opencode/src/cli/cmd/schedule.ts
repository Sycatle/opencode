import path from "path"
import type { Argv } from "yargs"
import { Global } from "@opencode-ai/core/global"
import { ForkAutonomy } from "@opencode-fork/core/autonomy"
import { ForkSchedule } from "@opencode-fork/core/schedule"
import { cmd } from "./cmd"

const self = () =>
  ForkAutonomy.selfCommand(process.execPath, process.argv).map((part, index) => (index === 1 ? path.resolve(part) : part))

const line = () =>
  ForkSchedule.crontabLine({
    home: process.env.HOME ?? "~",
    self: self(),
    log: path.join(Global.Path.data, "schedule", "tick.log"),
  })

const routineID = (yargs: Argv) => yargs.positional("id", { type: "number", demandOption: true })

const AddCommand = cmd({
  command: "add <cron> [prompt..]",
  describe: 'store a routine: schedule add "0 9 * * 1-5" --name daily -- fix the flaky tests',
  builder: (yargs) =>
    yargs
      .positional("cron", { type: "string", demandOption: true, describe: '5-field cron expression, e.g. "*/15 * * * *"' })
      .positional("prompt", { type: "string", array: true, default: [] as string[], describe: "prompt for the agent (after --)" })
      .option("name", { type: "string", describe: "routine name" })
      .option("dir", { type: "string", describe: "directory to run in (default: current directory)" })
      .option("auto", {
        type: "string",
        describe: "completion check command: run `opencode auto --until <check>` instead of `opencode run`",
      })
      .option("budget", { type: "number", describe: "maximum cost in USD per run" }),
  handler: (args) => {
    const parsed = ForkSchedule.parse(args.cron)
    if (!parsed.ok) return fail(`Invalid cron: ${parsed.error}`)
    const prompt = [...args.prompt, ...(args["--"] ?? [])]
    if (!prompt.length) return fail("Missing prompt: pass it after `--`.")
    const id = ForkSchedule.add({
      name: args.name,
      cron: args.cron,
      dir: path.resolve(args.dir ?? process.cwd()),
      argv: ForkSchedule.buildArgv({ prompt, check: args.auto, budget: args.budget }),
    })
    console.log(`Added routine ${id}, next run ${format(ForkSchedule.next(args.cron, new Date()))}`)
    console.log("Run `opencode schedule install` once so a crontab line triggers due routines.")
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "list routines with next and last run",
  builder: (yargs) => yargs,
  handler: () => {
    const routines = ForkSchedule.list()
    if (!routines.length) return console.log("No routines.")
    routines.forEach((routine) =>
      console.log(
        [
          String(routine.id).padStart(3),
          routine.name,
          `"${routine.cron}"`,
          routine.dir,
          `next ${format(ForkSchedule.next(routine.cron, new Date(routine.last_run ?? routine.created)))}`,
          `last ${routine.last_run ? new Date(routine.last_run).toLocaleString() : "never"}${routine.last_status ? ` ${routine.last_status}${routine.last_exit === null ? "" : ` (exit ${routine.last_exit})`}` : ""}`,
        ].join("  "),
      ),
    )
  },
})

const RemoveCommand = cmd({
  command: "rm <id>",
  describe: "delete a routine",
  builder: routineID,
  handler: (args) => {
    if (!ForkSchedule.remove(args.id)) return fail(`No routine ${args.id}.`)
    console.log(`Removed routine ${args.id}.`)
  },
})

const RunCommand = cmd({
  command: "run <id>",
  describe: "run a routine now, in the foreground",
  builder: (yargs) =>
    routineID(yargs).option("claimed", { type: "boolean", default: false, hidden: true, describe: "lock already taken by tick" }),
  handler: async (args) => {
    const routine = ForkSchedule.get(args.id)
    if (!routine) return fail(`No routine ${args.id}.`)
    if (!args.claimed && !ForkSchedule.claim(routine.id)) return fail(`Routine ${routine.id} is already running.`)
    const log = ForkSchedule.logPath(Global.Path.data, routine.id)
    const result = await ForkSchedule.execute(routine, self(), log)
    console.log(
      `Routine ${routine.id} ${result.exit === 0 ? "ok" : "failed"} (exit ${result.exit}) in ${(result.duration / 1000).toFixed(1)}s, log ${log}`,
    )
    if (result.exit !== 0) process.exitCode = 1
  },
})

const TickCommand = cmd({
  command: "tick",
  describe: "start every due routine in a detached process (called by crontab each minute)",
  builder: (yargs) => yargs,
  handler: () => {
    ForkSchedule.dueRoutines(new Date())
      .filter((routine) => ForkSchedule.claim(routine.id))
      .forEach((routine) => {
        Bun.spawn([...self(), "schedule", "run", String(routine.id), "--claimed"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        }).unref()
        console.log(`${new Date().toISOString()} started routine ${routine.id} (${routine.name})`)
      })
  },
})

const InstallCommand = cmd({
  command: "install",
  describe: "add the single crontab line that drives `schedule tick`",
  builder: (yargs) =>
    yargs.option("print", { type: "boolean", default: false, describe: "print the crontab line without installing" }),
  handler: async (args) => {
    if (args.print) return console.log(line())
    const crontab = ForkSchedule.systemCrontab()
    if (!crontab) return console.log(`crontab not found. Add this line to your scheduler manually:\n\n${line()}`)
    console.log((await ForkSchedule.install(crontab, line())) ? "Crontab line installed." : "Crontab line already installed.")
  },
})

const UninstallCommand = cmd({
  command: "uninstall",
  describe: "remove the crontab line",
  builder: (yargs) => yargs,
  handler: async () => {
    const crontab = ForkSchedule.systemCrontab()
    if (!crontab) return fail("crontab not found.")
    console.log((await ForkSchedule.uninstall(crontab)) ? "Crontab line removed." : "No crontab line installed.")
  },
})

export const ScheduleCommand = cmd({
  command: "schedule",
  describe: "manage local scheduled routines driven by a single crontab line",
  builder: (yargs) =>
    yargs
      .command(AddCommand)
      .command(ListCommand)
      .command(RemoveCommand)
      .command(RunCommand)
      .command(TickCommand)
      .command(InstallCommand)
      .command(UninstallCommand)
      .demandCommand(),
  handler: () => {},
})

function format(date: Date | undefined) {
  return date ? date.toLocaleString() : "never"
}

function fail(message: string) {
  console.error(message)
  process.exitCode = 1
}
