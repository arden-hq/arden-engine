import { messageQuote } from "./message-quote.js"
import {
  COMMUNICATION_DOOR,
  UPDATE_WEIGHT,
  type ChatUpdate,
  type CommunicationDoor
} from "@arden-hq/protocol/chat"
import { RECORD_TOLD_STATUS } from "@arden-hq/protocol"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { RunDeliveryPayload } from "../deliveries/model.js"
import {
  ENDING_DETAIL,
  ENDING_PURPOSE,
  ENDING_STATUS,
  PLACE_KIND,
  type EndingRecord
} from "../runs/ending.js"
import { arrivalHeadline, arrivalSource, doorRef } from "../transcript/chat-events.js"
import { postQuietLine } from "./ending-arrival.js"
import type { EntityFact } from "./entity-events.js"
import type { DestinationRow } from "./run-destination.js"
import { enqueueRunDelivery } from "./work-delivery-routing.js"

const OWNER_UPDATE_WEIGHT = { ...UPDATE_WEIGHT, quiet: "quiet" } as const

export type UpdateWeight = (typeof OWNER_UPDATE_WEIGHT)[keyof typeof OWNER_UPDATE_WEIGHT]

const UPDATE_FACT = { ending: "ending", entity: "entity", tell: "tell", met: "met" } as const

export type UpdatePayload = Extract<RunDeliveryPayload, { readonly kind: "update" }>

export type Readable = Pick<EndingRecord, "purpose" | "status" | "detail" | "text" | "placeKind">

export const told = (record: Readable): boolean =>
  record.placeKind === PLACE_KIND.chat &&
  record.text.trim() !== "" &&
  record.purpose !== ENDING_PURPOSE.system &&
  (record.status === ENDING_STATUS.finished ||
    record.status === ENDING_STATUS.blocked ||
    record.status === ENDING_STATUS.failed)

export const waitsOnOwner = (detail: string | null): boolean =>
  detail === ENDING_DETAIL.needsYou ||
  detail === ENDING_DETAIL.needsInput ||
  detail === ENDING_DETAIL.capability

export type UpdateFact =
  | { readonly kind: typeof UPDATE_FACT.ending; readonly record: Readable; readonly shown: boolean }
  | { readonly kind: typeof UPDATE_FACT.entity; readonly fact: EntityFact; readonly shown: boolean }
  | { readonly kind: typeof UPDATE_FACT.tell; readonly shown: boolean }
  | { readonly kind: typeof UPDATE_FACT.met; readonly shown: boolean }

export const updateWeight = (fact: UpdateFact): UpdateWeight | undefined => {
  switch (fact.kind) {
    case UPDATE_FACT.ending: {
      if (!told(fact.record)) return undefined
      const { status, detail } = fact.record
      if (!fact.shown)
        return status === ENDING_STATUS.finished && detail === ENDING_DETAIL.step
          ? OWNER_UPDATE_WEIGHT.news
          : OWNER_UPDATE_WEIGHT.quiet
      return status === ENDING_STATUS.failed ||
        (status === ENDING_STATUS.blocked && waitsOnOwner(detail))
        ? OWNER_UPDATE_WEIGHT.owed
        : OWNER_UPDATE_WEIGHT.news
    }
    case UPDATE_FACT.entity:
      return entityWeight(fact.fact, fact.shown)
    case UPDATE_FACT.tell:
    case UPDATE_FACT.met:
      return fact.shown ? OWNER_UPDATE_WEIGHT.news : OWNER_UPDATE_WEIGHT.quiet
  }
}

export const entityWeight = (fact: EntityFact, shown: boolean): UpdateWeight => {
  if (!shown) return OWNER_UPDATE_WEIGHT.quiet
  return fact.event === RECORD_TOLD_STATUS.done
    ? OWNER_UPDATE_WEIGHT.news
    : OWNER_UPDATE_WEIGHT.owed
}

export const tellChat = Effect.fn("OwnerUpdate.tellChat")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly weight: UpdateWeight
  readonly occurrenceKey: string
  readonly source: UpdatePayload["source"]
  readonly sourceRunId: string
  readonly sourceSessionRef: string
  readonly destination: DestinationRow
  readonly line: string
  readonly door: CommunicationDoor
  readonly event: ChatUpdate["event"]
  readonly occurredAt: string
}) {
  const { weight, ...told } = options
  if (weight === OWNER_UPDATE_WEIGHT.quiet) return yield* postQuietLine(told)
  yield* enqueueUpdate({ ...told, weight })
})

const enqueueUpdate = Effect.fn("OwnerUpdate.enqueue")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly occurrenceKey: string
  readonly destination: DestinationRow
  readonly source: UpdatePayload["source"]
  readonly weight: ChatUpdate["weight"]
  readonly event: ChatUpdate["event"]
  readonly line: string
  readonly door: CommunicationDoor
  readonly occurredAt: string
}) {
  const { sql, door } = options
  const line = options.line.trim()
  if (line === "") return
  const update: ChatUpdate = {
    key: options.occurrenceKey,
    weight: options.weight,
    event: options.event,
    line,
    door
  }
  const taskItem =
    door.kind === COMMUNICATION_DOOR.task || door.kind === COMMUNICATION_DOOR.artifact
      ? door.item_id
      : undefined
  const stableKey =
    taskItem === undefined
      ? null
      : ((yield* sql<{ readonly stable_key: string | null }>`SELECT stable_key FROM space_tasks
          WHERE item_id = ${taskItem}`)[0]?.stable_key ?? null)
  const replyTo =
    taskItem !== undefined
      ? yield* originQuote(sql, taskItem, options.destination.session_id)
      : undefined
  yield* enqueueRunDelivery({
    sql,
    eventId: options.occurrenceKey,
    subject: options.event,
    body: `${arrivalHeadline({ event: update.event, source: arrivalSource(door), name: door.label })} (${doorRef(door, stableKey)})\n${line}`,
    payload: {
      kind: "update",
      sessionId: options.destination.session_id,
      source: options.source,
      update,
      ...(replyTo === undefined ? {} : { replyTo }),
      occurredAt: options.occurredAt
    },
    now: options.occurredAt
  })
})

const originQuote = Effect.fn("OwnerUpdate.originQuote")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
  sessionId: string
) {
  const origin = (yield* sql<{ readonly message_id: string | null }>`
    SELECT task.origin_message_id AS message_id FROM space_tasks AS task
    WHERE task.item_id = ${itemId} AND EXISTS (SELECT 1 FROM space_task_sources AS source
      WHERE source.item_id = task.item_id AND json_extract(source.source, '$.kind') = 'chat'
        AND json_extract(source.source, '$.session_id') = ${sessionId})`)[0]
  if (origin === undefined || origin.message_id === null) return undefined
  return yield* messageQuote(sql, { sessionId, messageId: origin.message_id })
})
