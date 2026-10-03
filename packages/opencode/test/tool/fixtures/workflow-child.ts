// Stands in for `opencode workflow run` in the workflow tool test: same arguments, same run bookkeeping,
// but agents are answered by a fake model instead of spawning `opencode run`.
import path from "path"
import { pathToFileURL } from "url"
import { ForkWorkflow } from "@opencode-fork/core/workflow"

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const file = path.resolve(argv[0])
const runID = option("--resume") ?? option("--id") ?? ForkWorkflow.newRunID()
const mod = await import(pathToFileURL(file).href)

ForkWorkflow.startRun(runID, file, mod.meta.name)
process.on("SIGTERM", () => {
  ForkWorkflow.finishRun(runID, "interrupted")
  process.exit(143)
})

const count = { agents: 0 }
const runtime = ForkWorkflow.createRuntime({
  runID,
  concurrency: 4,
  budget: option("--budget") ? Number(option("--budget")) : undefined,
  cost: () => 0.125,
  progress: (line) => console.error(line),
  execute: async (prompt) => {
    count.agents++
    await Bun.sleep(800)
    return { text: `answer to: ${prompt}`, sessionID: `ses_fake_${runID}_${count.agents}` }
  },
})

const args = option("--args") ? JSON.parse(String(option("--args"))) : undefined
const outcome = await Promise.resolve(
  mod.default({
    agent: runtime.agent,
    parallel: runtime.parallel,
    pipeline: runtime.pipeline,
    phase: runtime.phase,
    log: runtime.log,
    args,
  }),
).then(
  (value: unknown) => ({ value, failed: undefined }),
  (error: unknown) => ({ value: undefined, failed: error }),
)
if (outcome.failed) {
  ForkWorkflow.finishRun(runID, "failed")
  console.error(`failed: ${outcome.failed instanceof Error ? outcome.failed.message : String(outcome.failed)}`)
  process.exit(1)
}
ForkWorkflow.finishRun(runID, "done")
console.log(JSON.stringify(outcome.value ?? null, null, 2))
