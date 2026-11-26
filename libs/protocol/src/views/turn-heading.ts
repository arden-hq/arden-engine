import { formatDuration } from "@arden-hq/std/time"

export function turnDurationWords(durationMs: number): string {
  return durationMs < 1000 ? "less than a second" : formatDuration(durationMs)
}

export interface TurnHeading {
  readonly text: string
  readonly time: string | null
}

export function turnHeading(
  durationMs: number | null | undefined,
  wasStopped: boolean,
  summary: string | undefined,
  thoughtOnly = false
): TurnHeading {
  const time = durationMs != null ? formatDuration(durationMs) : null
  if (wasStopped)
    return {
      text: durationMs != null ? `Stopped after ${turnDurationWords(durationMs)}` : "Stopped",
      time: null
    }
  if (summary) return { text: summary, time }
  if (thoughtOnly) return { text: "Thought", time }
  return durationMs != null
    ? { text: `Took ${turnDurationWords(durationMs)}`, time: null }
    : { text: "Done", time: null }
}

export function turnHeadingText(heading: TurnHeading): string {
  return heading.time ? `${heading.text}, ${heading.time}` : heading.text
}
