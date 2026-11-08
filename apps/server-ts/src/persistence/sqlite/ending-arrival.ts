import { cutText, foldSpace } from "@arden-hq/std/text"
import type { ChatUpdate, CommunicationArrival, CommunicationDoor } from "@arden-hq/protocol/chat"
import { CommunicationArrivalSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { allocateSequence, type CommunicationDeliveryPayload } from "./continuity-payload.js"
import { communicationError } from "./continuity-route.js"
import type { DestinationRow } from "./run-destination.js"
import { canonicalJson } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

export type ArrivalEvent = ChatUpdate["event"]

const LINE_LIMIT = 500

const arrivalLine = (text: string): string => cutText(foldSpace(text), LINE_LIMIT)

export const postQuietLine = Effect.fn("EndingArrival.postQuietLine")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly occurrenceKey: string
  readonly sourceRunId: string
  readonly sourceSessionRef: string
  readonly destination: DestinationRow
  readonly line: string
  readonly door: CommunicationDoor
  readonly event: ArrivalEvent
  readonly occurredAt: string
}) {
  const { sql, destination, event, occurredAt } = options
  const line = arrivalLine(options.line)
  if (line === "") return
  const deliveryId = sha256Hex(options.occurrenceKey)
  if (
    (yield* sql`SELECT 1 FROM automation_deliveries WHERE delivery_id = ${deliveryId}`).length > 0
  )
    return
  const sequence = yield* allocateSequence(sql)
  const draft = {
    arrival_id: deliveryId,
    occurrence_key: options.occurrenceKey,
    source_run_id: options.sourceRunId,
    source_session_ref: options.sourceSessionRef,
    destination_space_id: destination.space_id,
    destination_session_ref: destination.public_ref,
    source_sequence: sequence,
    occurred_at: occurredAt,
    line,
    door: options.door,
    event
  }
  const payloadHash = sha256Hex(canonicalJson(draft))
  const arrival: CommunicationArrival = yield* Schema.decodeUnknownEffect(
    CommunicationArrivalSchema
  )({
    ...draft,
    payload_hash: payloadHash
  }).pipe(
    Effect.mapError((cause) => communicationError("invalid", "Ending arrival is invalid", cause))
  )
  const payload: CommunicationDeliveryPayload = {
    kind: "communication",
    event,
    occurrenceKey: options.occurrenceKey,
    requestHash: payloadHash,
    payloadHash,
    sourceSequence: sequence,
    sourceRunId: options.sourceRunId,
    sourceSessionRef: options.sourceSessionRef,
    destinationSessionId: destination.session_id,
    destinationSpaceId: destination.space_id,
    visible: true,
    shown: false,
    arrival
  }
  yield* sql`INSERT INTO automation_deliveries (
      delivery_id, task_id, delivered_at, subject, body, payload, status, created_at,
      destinations, attempt_count, next_attempt_at, last_error, communication_sequence
    ) VALUES (
      ${deliveryId}, NULL, NULL, ${event}, ${arrival.line}, ${canonicalJson(payload)},
      'pending', ${occurredAt}, '[]', 0, NULL, NULL, ${sequence}
    ) ON CONFLICT(delivery_id) DO NOTHING`
})

export const taskDoor = (itemId: string, title: string): CommunicationDoor => ({
  kind: "task",
  label: cutText(title, 160),
  item_id: itemId,
  href: `arden:task/${encodeURIComponent(itemId)}`
})
