import type { ChatUpdate, CommunicationDoor } from "@arden-hq/protocol/chat"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { RunDeliveryPayload } from "../deliveries/model.js"
import type { EndingRecord } from "../runs/ending.js"
import { arrivalHeadline, arrivalSource, doorRef } from "../transcript/chat-events.js"
import { postQuietLine } from "./ending-arrival.js"
import type { EntityFact } from "./entity-events.js"
import type { DestinationRow } from "./run-destination.js"
import { enqueueRunDelivery } from "./work-deliveries.js"

export type UpdateWeight = ChatUpdate["weight"] | "quiet"

export type UpdatePayload = Extract<RunDeliveryPayload, { readonly kind: "update" }>

export type Readable = Pick<EndingRecord, "purpose" | "status" | "detail" | "text" | "placeKind">

export const told = (record: Readable): boolean =>
  record.placeKind === "chat" &&
  record.text.trim() !== "" &&
  record.purpose !== "system" &&
  (record.status === "finished" || record.status === "blocked" || record.status === "failed")

export const waitsOnOwner = (detail: string | null): boolean =>
  detail === "needs_you" || detail === "needs_input" || detail === "capability"

export type UpdateFact =
  | { readonly kind: "ending"; readonly record: Readable; readonly shown: boolean }
  | { readonly kind: "entity"; readonly fact: EntityFact; readonly shown: boolean }
  | { readonly kind: "tell"; readonly shown: boolean }
  | { readonly kind: "met"; readonly shown: boolean }

export const updateWeight = (fact: UpdateFact): UpdateWeight | undefined => {
  switch (fact.kind) {
    case "ending": {
      if (!told(fact.record)) return undefined
      const { status, detail } = fact.record
      if (!fact.shown) return status === "finished" && detail === "step" ? "news" : "quiet"
      return status === "failed" || (status === "blocked" && waitsOnOwner(detail)) ? "owed" : "news"
    }
    case "entity":
      return entityWeight(fact.fact, fact.shown)
    case "tell":
    case "met":
      return fact.shown ? "news" : "quiet"
  }
}

export const entityWeight = (fact: EntityFact, shown: boolean): UpdateWeight => {
  if (!shown) return "quiet"
  return fact.event === "done" ? "news" : "owed"
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
  if (weight === "quiet") return yield* postQuietLine(told)
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
  const stableKey =
    door.kind === "task" || door.kind === "artifact"
      ? ((yield* sql<{ readonly stable_key: string | null }>`SELECT stable_key FROM space_tasks
          WHERE item_id = ${door.item_id}`)[0]?.stable_key ?? null)
      : null
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
      occurredAt: options.occurredAt
    },
    now: options.occurredAt
  })
})
