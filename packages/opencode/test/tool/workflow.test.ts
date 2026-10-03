import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ForkWorkflow } from "@opencode-fork/core/workflow"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { BackgroundJob } from "@/background/job"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShellKillTool, ShellOutputTool } from "../../src/tool/shell-background"
import { WorkflowTool } from "../../src/tool/workflow"
import type { TaskPromptOps } from "../../src/tool/task"
import type { SessionPrompt } from "../../src/session/prompt"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = Layer.mergeAll(LayerNode.compile(LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      BackgroundJob.node,
    ])), testInstanceStoreLayer)
const it = testEffect(layer)

// The real child is `opencode workflow run`, which spawns `opencode run` per agent and needs a model.
// This one has the same arguments and bookkeeping and answers agents itself.
const workflowCommand = [process.execPath, path.join(__dirname, "fixtures/workflow-child.ts")]

const twoAgents = `export const meta = { name: "pair", description: "two agents" }
export default async function ({ agent, parallel, args }) {
  const [a, b] = await parallel([
    () => agent("first job", { label: "first" }),
    async () => {
      if (args?.fail) throw new Error("boom")
      return agent("second job", { label: "second" })
    },
  ])
  return { a, b }
}
`

const ctx = {
  sessionID: SessionID.make("ses_workflow_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const notified = Effect.gen(function* () {
  const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
  const promptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input: SessionPrompt.PromptInput) => Deferred.succeed(injected, input).pipe(Effect.as({} as never)),
  } satisfies TaskPromptOps
  return { injected, next: { ...ctx, extra: { promptOps, workflowCommand } } }
})

const textOf = (input: SessionPrompt.PromptInput) => {
  const part = input.parts[0]
  return part && "text" in part ? part.text : ""
}

const tools = Effect.gen(function* () {
  return {
    workflow: yield* (yield* WorkflowTool).init(),
    output: yield* (yield* ShellOutputTool).init(),
    kill: yield* (yield* ShellKillTool).init(),
  }
})

describe.skipIf(process.platform === "win32")("tool.workflow", () => {
  it.live("runs an inline script in the background, notifies, and resumes a run", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { workflow, output } = yield* tools

        const first = yield* notified
        const started = yield* workflow.execute({ script: twoAgents, args: { fail: true } }, first.next)
        const runID = String(started.metadata.runId)
        const jobID = String(started.metadata.jobId)
        expect(started.output).toContain(runID)
        expect(started.output).toContain(String(started.metadata.script))
        expect(started.output).toContain("notified automatically")
        expect(yield* Effect.promise(() => Bun.file(String(started.metadata.script)).text())).toBe(twoAgents)

        // The tool returned while the run is still going.
        expect(yield* jobs.get(jobID)).toMatchObject({ type: "workflow", status: "running" })
        expect(ForkWorkflow.getRun(runID)?.status).toBe("running")

        expect((yield* jobs.wait({ id: jobID })).info?.status).toBe("completed")
        const text = textOf(yield* Deferred.await(first.injected))
        expect(text).toContain(`<workflow id="${runID}" name="pair" state="completed"`)
        // parallel() turns the failing agent into null; the first one answered.
        expect(text).toContain('"b": null')
        expect(text).toContain("answer to: first job")
        expect(ForkWorkflow.getRun(runID)?.status).toBe("done")

        const status = yield* output.execute({ id: jobID }, first.next)
        expect(status.output).toContain(`run ${runID} · pair · done`)
        expect(status.output).toContain("done     first")

        // Resume by run id alone: the finished agent is cached, the other one runs now.
        const second = yield* notified
        const again = yield* workflow.execute({ resumeFromRunId: runID, args: { fail: false } }, second.next)
        expect(again.output).toContain("resumed in the background")
        expect(again.metadata.runId).toBe(runID)
        const result = String((yield* jobs.wait({ id: String(again.metadata.jobId) })).info?.output)
        expect(result).toContain("answer to: second job")
        expect(textOf(yield* Deferred.await(second.injected))).toContain('state="completed"')
        const log = yield* Effect.promise(() => Bun.file(String(again.metadata.outputPath)).text())
        expect(log).toContain("first: cached")
        expect(log).toContain("second: done")
      }).pipe(provideInstance(dir))
    }),
  )

  it.live("reports a failing run as an error and marks a stopped run interrupted", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { workflow, kill, output } = yield* tools

        const crash = yield* notified
        yield* workflow.execute(
          { script: `export const meta = { name: "crash" }\nexport default async function () { throw new Error("nope") }\n` },
          crash.next,
        )
        const crashText = textOf(yield* Deferred.await(crash.injected))
        expect(crashText).toContain('state="error"')
        expect(crashText).toContain("failed: nope")

        const slow = yield* notified
        const started = yield* workflow.execute(
          {
            script: `export const meta = { name: "slow" }\nexport default async function () { await new Promise((resolve) => setTimeout(resolve, 60000)) }\n`,
          },
          slow.next,
        )
        const runID = String(started.metadata.runId)
        const jobID = String(started.metadata.jobId)
        while (ForkWorkflow.getRun(runID)?.status !== "running") yield* Effect.sleep("50 millis")
        expect((yield* kill.execute({ id: jobID }, slow.next)).output).toContain("stopped")
        expect((yield* jobs.get(jobID))?.status).toBe("cancelled")
        while (ForkWorkflow.getRun(runID)?.status === "running") yield* Effect.sleep("50 millis")
        expect(ForkWorkflow.getRun(runID)?.status).toBe("interrupted")
        expect(yield* Deferred.isDone(slow.injected)).toBe(false)
        expect((yield* output.execute({ id: jobID }, slow.next)).output).toContain("interrupted")
      }).pipe(provideInstance(dir))
    }),
  )

  it.live("validates the script, asks permission by meta name and passes the remaining budget", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const { workflow } = yield* tools
        const impure = yield* Effect.exit(
          workflow.execute({ script: `const name = "x"\nexport const meta = { name }\n` }, ctx),
        )
        expect(Exit.isFailure(impure)).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(workflow.execute({ script: twoAgents, scriptPath: "x.js" }, ctx)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(workflow.execute({ resumeFromRunId: "wf_missing" }, ctx)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(workflow.execute({}, ctx)))).toBe(true)

        const asked: { permission: string; patterns: readonly string[] }[] = []
        const note = yield* notified
        const previous = process.env.OPENCODE_FORK_BUDGET_USD
        process.env.OPENCODE_FORK_BUDGET_USD = "3"
        const started = yield* workflow
          .execute(
            { script: twoAgents },
            {
              ...note.next,
              ask: (input) =>
                Effect.sync(() => void asked.push({ permission: input.permission, patterns: input.patterns })),
            },
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) delete process.env.OPENCODE_FORK_BUDGET_USD
                else process.env.OPENCODE_FORK_BUDGET_USD = previous
              }),
            ),
          )
        expect(asked).toEqual([{ permission: "workflow", patterns: ["pair"] }])
        const log = yield* Effect.promise(() => Bun.file(String(started.metadata.outputPath)).text())
        expect(log).toContain("--budget 3")
        yield* Deferred.await(note.injected)
      }).pipe(provideInstance(dir))
    }),
  )
})
