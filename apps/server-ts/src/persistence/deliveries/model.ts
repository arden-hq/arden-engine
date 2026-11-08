import { AnswerWithdrawalReasonSchema, RunContextSchema } from "@arden-hq/protocol/effect/runs"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { ChatUpdateSchema, ConnectionArrivalSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"
import type { Interaction } from "@arden-hq/loop"
import type { ChatImageInput, HistoryMessage } from "@arden-hq/protocol/chat"

const deliveryFields = {
  progress: Schema.optionalKey(Schema.Boolean),
  timeout: Schema.optionalKey(Schema.Literal(true)),
  sessionId: Schema.NonEmptyString,
  context: RunContextSchema,
  runIds: Schema.NonEmptyArray(Schema.NonEmptyString).check(Schema.isUnique()),
  questionId: Schema.NullOr(Schema.NonEmptyString),
  destinationDeletedAt: Schema.optionalKey(IsoDateTimeStringSchema),
  withdrawal: Schema.optionalKey(
    Schema.Struct({
      at: Schema.NonEmptyString,
      reason: AnswerWithdrawalReasonSchema
    })
  ),
  settlement: Schema.optionalKey(
    Schema.Struct({
      at: IsoDateTimeStringSchema,
      reason: Schema.Literals(["destination_terminal", "chat_stopped"] as const),
      mode: Schema.Literals(["discarded", "recorded"] as const)
    })
  ),
  routing: Schema.optionalKey(
    Schema.Struct({
      at: IsoDateTimeStringSchema,
      fromSessionId: Schema.NonEmptyString,
      toSessionId: Schema.NonEmptyString
    })
  )
}
export const RunDeliveryPayloadSchema = Schema.Union([
  Schema.Struct({ ...deliveryFields, kind: Schema.Literals(["result", "answer"]) }),
  Schema.Struct({
    ...deliveryFields,
    kind: Schema.Literal("connection"),
    connection: ConnectionArrivalSchema
  }),
  Schema.Struct({
    ...deliveryFields,
    kind: Schema.Literal("thread"),
    revision: Schema.Int,
    forwarded: Schema.Struct({
      sessionId: Schema.NonEmptyString,
      messageId: Schema.NonEmptyString
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("update"),
    sessionId: Schema.NonEmptyString,
    source: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("ending"), runId: Schema.NonEmptyString }),
      Schema.Struct({
        kind: Schema.Literal("tell"),
        runId: Schema.NonEmptyString,
        n: Schema.Int
      }),
      Schema.Struct({
        kind: Schema.Literal("met"),
        runId: Schema.NonEmptyString,
        lineId: Schema.Int
      }),
      Schema.Struct({ kind: Schema.Literal("entity"), key: Schema.NonEmptyString })
    ]),
    update: ChatUpdateSchema,
    occurredAt: IsoDateTimeStringSchema,
    withdrawal: Schema.optionalKey(
      Schema.Struct({
        at: Schema.NonEmptyString,
        reason: Schema.Literals(["destination_archived", "destination_deleted"] as const)
      })
    )
  })
])
export type RunDeliveryPayload = typeof RunDeliveryPayloadSchema.Type
export interface RunDelivery {
  readonly deliveryId: string
  readonly attempt: number
  readonly subject: string
  readonly body: string
  readonly payload: RunDeliveryPayload
  readonly interaction?: Interaction
  readonly forwardedFrom?: HistoryMessage["forwarded_from"]
  readonly images?: ReadonlyArray<ChatImageInput>
}
