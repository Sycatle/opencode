import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createForkSuggestion } from "../src/components/prompt-input/fork-suggestion"

const settle = (check: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() > deadline) return reject(new Error("timed out"))
      setTimeout(tick, 20)
    }
    tick()
  })

describe("createForkSuggestion", () => {
  test("waits for the suggestion of the last assistant message", async () => {
    const calls: string[] = []
    await createRoot(async (dispose) => {
      const suggestion = createForkSuggestion({
        sessionID: () => "ses_1",
        messageID: () => "msg_2",
        fetch: async (sessionID) => {
          calls.push(sessionID)
          // The first answer still belongs to the previous turn.
          return calls.length === 1
            ? { enabled: true, messageID: "msg_1", text: "stale" }
            : { enabled: true, messageID: "msg_2", text: "run the tests" }
        },
      })
      await settle(() => suggestion() !== undefined)
      expect(suggestion()).toBe("run the tests")
      expect(calls).toHaveLength(2)
      dispose()
    })
  })

  test("shows nothing when the user turned suggestions off, and hides it for a new message", async () => {
    await createRoot(async (dispose) => {
      const [message, setMessage] = createSignal("msg_1")
      let enabled = true
      const suggestion = createForkSuggestion({
        sessionID: () => "ses_1",
        messageID: message,
        fetch: async () => (enabled ? { enabled, messageID: message(), text: `for ${message()}` } : { enabled }),
      })
      await settle(() => suggestion() === "for msg_1")

      enabled = false
      setMessage("msg_2")
      await settle(() => suggestion() === undefined)
      expect(suggestion()).toBeUndefined()
      dispose()
    })
  })
})
