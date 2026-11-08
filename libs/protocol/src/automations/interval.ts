/** Current time-trigger grammar: integer days, hours and minutes, in that order. */
export function parseIntervalMinutes(value: string): number | undefined {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i.exec(value.trim())
  if (!match) return undefined
  const minutes = Number(match[1] ?? 0) * 1_440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return Number.isFinite(minutes) && minutes >= 1 ? minutes : undefined
}
