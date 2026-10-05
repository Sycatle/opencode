// Context usage as a circle that fills up: ○ ◔ ◑ ◕ ●
export function contextGlyph(percent: number) {
  return percent < 13 ? "○" : percent < 38 ? "◔" : percent < 63 ? "◑" : percent < 88 ? "◕" : "●"
}

export function contextLevel(percent: number | null | undefined) {
  return (percent ?? 0) >= 95 ? ("error" as const) : (percent ?? 0) >= 80 ? ("warning" as const) : ("ok" as const)
}

// 18900 -> "18.9K", 200000 -> "200K"
export function compactTokens(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(".0", "")}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1).replace(".0", "")}K`
      : String(value)
}

// Rough count for text that has no provider figure yet (a message being typed or streamed).
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}
