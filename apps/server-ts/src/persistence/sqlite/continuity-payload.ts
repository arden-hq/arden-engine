import type { CommunicationArrival } from "@arden-hq/protocol/chat"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { communicationError } from "./continuity-route.js"

export interface CommunicationDeliveryPayload {
  readonly kind: "communication"
  readonly event:
    | "finished"
    | "blocked"
    | "needs_you"
    | "failed"
    | "paused"
    | "told"
    | "met"
    | "no_change"
  readonly occurrenceKey: string
  readonly requestHash: string
  readonly payloadHash: string
  readonly sourceSequence: number
  readonly sourceRunId: string
  readonly sourceSessionRef: string
  readonly destinationSessionId: string
  readonly destinationSpaceId: string | null
  readonly visible: boolean
  readonly shown?: boolean
  readonly arrival?: CommunicationArrival
  readonly evidence?: string
}

export const allocateSequence = Effect.fn(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{ readonly sequence: number }>`
    UPDATE communication_sequence_clock
    SET current_sequence = current_sequence + 1
    WHERE singleton_id = 1
    RETURNING current_sequence AS sequence`
  const sequence = rows[0]?.sequence
  if (sequence === undefined)
    return yield* communicationError("storage", "Communication clock is unavailable")
  return sequence
})
