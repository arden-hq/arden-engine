import { SESSION_HANDOFF_MARKER } from "../persistence/transcript/model.js"

export const HANDOFF_BYTES_PER_TOKEN = 3

export const estimateHistoryTokens = (messages: ReadonlyArray<unknown>): number =>
  Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / HANDOFF_BYTES_PER_TOKEN)

export const handoffContent = ({
  summary,
  sessionRef,
  sourceSessionRef
}: {
  readonly summary: string
  readonly sessionRef: string
  readonly sourceSessionRef?: string | undefined
}): string =>
  `${SESSION_HANDOFF_MARKER}\n\n${summary}\n\n[Archived conversation]\nDetailed evidence remains in chat ${JSON.stringify(sessionRef)}.${sourceSessionRef === undefined ? "" : ` Earlier inherited history is in source chat ${JSON.stringify(sourceSessionRef)}; use that chat's own sequence numbers.`} Use session_search_transcripts with the relevant session_ref and lookup hints above; then use session_read with the returned around_seq to recover exact messages. Page long results with content_offset. Retrieve the original before relying on an omitted quote, number, or tool result. Recent messages after this handoff remain authoritative.`

export const readHandoff = (content: string): string =>
  (content.startsWith(SESSION_HANDOFF_MARKER)
    ? content.slice(SESSION_HANDOFF_MARKER.length)
    : content
  ).trim()
