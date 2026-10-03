import type { Hooks } from "@opencode-ai/plugin"
import { ForkGuard } from "@opencode-fork/core/guard"
import { ForkJev } from "@opencode-fork/core/jev"

// Prompt-injection guard on the output of webfetch (default on with TYPESAFE_API_KEY) and of MCP tools (opt-in:
// OPENCODE_FORK_INJECTION_MCP_JEV=1). Fail-open: a Jev failure leaves the output as it is (see ForkGuard).
// MCP results reach this hook raw (`content` items), native tools as `{ output }`.
export async function ForkGuardPlugin(): Promise<Hooks> {
  return {
    "tool.execute.after": async (info, output) => {
      if (!output) return
      const raw: unknown = output
      const content = record(raw).content
      const items = Array.isArray(content) ? content : undefined
      const mode = items ? ForkJev.mode("INJECTION_MCP", process.env, "off") : info.tool === "webfetch" ? ForkJev.mode("INJECTION") : "off"
      if (mode === "off") return
      const text = items
        ? items.flatMap((item) => (typeof record(item).text === "string" ? [String(record(item).text)] : [])).join("\n")
        : typeof output.output === "string"
          ? output.output
          : ""
      if (text.length < ForkGuard.MIN_CHARS) return
      const response = await ForkJev.ask(ForkGuard.request(text))
      const injection = ForkGuard.probability(response.answers)
      const flagged = injection !== undefined && injection >= ForkGuard.AT
      ForkJev.journal({
        feature: "injection",
        session_id: info.sessionID,
        ms: response.ms,
        ok: injection !== undefined,
        error: response.error ?? (injection === undefined ? "Jev response unusable" : undefined),
        decision: flagged ? "flag" : "pass",
        other: items ? "mcp" : info.tool,
        answers: response.answers,
      })
      if (!flagged || mode === "shadow") return
      ForkGuard.mark(info.sessionID)
      if (items) items.unshift({ type: "text", text: ForkGuard.WARNING })
      else {
        output.output = `${ForkGuard.WARNING}\n\n${output.output}`
        output.metadata = { ...output.metadata, forkInjection: injection }
      }
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}
}
