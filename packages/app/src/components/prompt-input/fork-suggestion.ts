import { createResource, type Accessor } from "solid-js"

// FORK-SEAM: prompt-suggestion-web (grey next-prompt suggestion in the empty composer, accepted with Tab)

const POLL_MS = 1500
const POLL_TRIES = 10

type Fetch = (sessionID: string) => Promise<{ enabled: boolean; messageID?: string; text?: string } | undefined>

// The server writes the suggestion some seconds after a turn ends, so poll until it belongs to the last assistant
// message. A new turn or a new user message changes `messageID`, which retires the previous suggestion.
export function createForkSuggestion(input: {
  sessionID: Accessor<string | undefined>
  messageID: Accessor<string | undefined>
  fetch: Fetch
}) {
  const [text] = createResource(
    () => {
      const sessionID = input.sessionID()
      const messageID = input.messageID()
      return sessionID && messageID ? { sessionID, messageID } : undefined
    },
    async (source) => {
      for (const attempt of Array.from({ length: POLL_TRIES }, (_, index) => index)) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        const result = await input.fetch(source.sessionID)
        if (!result?.enabled) return undefined
        if (result.messageID === source.messageID) return result.text
      }
      return undefined
    },
  )
  // While a new turn's suggestion is loading, the resource still holds the previous one: hide it.
  return () => (text.loading ? undefined : text())
}
