import { decoderFor } from "../common/boundary.js"
import { RecordedHistoryPageSchema } from "./schema.js"
export type { RecordedHistoryInput, RecordedHistoryPage } from "./schema.js"

export type RecordedHistoryDomain = "task" | "proposal" | "space" | "session" | "automation"
export const decodeRecordedHistory = decoderFor(
  RecordedHistoryPageSchema,
  "Invalid recorded history"
)

/** Exact windows on the existing domain-owned readers. */
export function recordedHistoryPath(input: {
  readonly domain: RecordedHistoryDomain
  readonly id: string
  readonly version: number
}): string {
  if (!input.id || !Number.isSafeInteger(input.version) || input.version < 1)
    throw new Error("Invalid history revision")
  const id = encodeURIComponent(input.id)
  const paths: Record<RecordedHistoryDomain, string> = {
    task: `/spaces/work/${id}/history`,
    proposal: `/proposals/${id}/history`,
    space: `/spaces/${id}/history`,
    session: `/sessions/${id}/configuration-history`,
    automation: `/automations/${id}/configuration-history`
  }
  return `${paths[input.domain]}?after_version=${input.version - 1}&through_version=${input.version}&limit=1`
}
