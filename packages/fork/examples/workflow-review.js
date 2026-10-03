export const meta = {
  name: "review",
  description: "Two parallel reviewers inspect the working tree; an aggregator merges their findings.",
  phases: ["review", "aggregate"],
}

const verdict = {
  type: "object",
  required: ["verdict", "issues"],
  properties: {
    verdict: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
}

export default async function ({ agent, parallel, phase, args, log }) {
  const target = args?.target ?? "the uncommitted changes (git diff)"
  phase("review")
  const reviews = await parallel([
    () => agent(`Review ${target} for correctness bugs. Read-only: do not edit files.`, { label: "bugs" }),
    () => agent(`Review ${target} for security and error-handling problems. Read-only: do not edit files.`, { label: "security" }),
  ])
  log(`${reviews.filter(Boolean).length}/2 reviews completed`)

  phase("aggregate")
  return agent(
    `Merge these two reviews into one verdict (ship, fix or block) and a deduplicated list of issues.\n\n${reviews
      .filter(Boolean)
      .map((review, i) => `### Review ${i + 1}\n${review}`)
      .join("\n\n")}`,
    { label: "aggregate", schema: verdict },
  )
}
