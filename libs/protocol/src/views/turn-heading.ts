import { formatDuration } from "@arden-hq/std/time"

/** A duration inside a sentence: the compact form, "less than a second" under 1 s. */
export function turnDurationWords(durationMs: number): string {
  return durationMs < 1000 ? "less than a second" : formatDuration(durationMs)
}

/** A settled fold's heading: what the turn did, then how long it took as a
 *  quieter second part ("Listed chats, reported a blocker", "1m 26s"). The
 *  fold says what is inside it, so a reader knows whether to open it; a
 *  duration alone ("Worked for 1m 26s") said only that something happened.
 *  A stop outranks everything and keeps its own sentence. */
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

/** The heading as one string, for labels and announcements. */
export function turnHeadingText(heading: TurnHeading): string {
  return heading.time ? `${heading.text}, ${heading.time}` : heading.text
}
