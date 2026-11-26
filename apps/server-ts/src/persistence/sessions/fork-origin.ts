import { Option, Schema } from "effect"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { isJsonObject } from "../json.js"

export const SessionForkOriginSchema = Schema.Struct({
  sourceSessionId: Schema.NonEmptyString,
  sourceSessionRef: Schema.NullOr(Schema.NonEmptyString),
  throughSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  sourceMessageId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: IsoDateTimeStringSchema
})

export type SessionForkOrigin = typeof SessionForkOriginSchema.Type

const LegacyForkSchema = Schema.Struct({
  source_session_id: Schema.NonEmptyString,
  through_sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))
})

export const sessionForkOriginFromMetadata = (
  metadata: unknown,
  startedAt: string
): (typeof SessionForkOriginSchema)["Type"] | undefined => {
  const current = Schema.decodeUnknownOption(SessionForkOriginSchema)(
    isJsonObject(metadata) ? metadata.fork_origin : undefined
  )
  if (Option.isSome(current)) return current.value
  const legacy = Schema.decodeUnknownOption(LegacyForkSchema)(
    isJsonObject(metadata) ? metadata.fork_of : undefined
  )
  if (Option.isNone(legacy)) return undefined
  const origin = Schema.decodeUnknownOption(SessionForkOriginSchema)({
    sourceSessionId: legacy.value.source_session_id,
    sourceSessionRef: null,
    throughSequence: legacy.value.through_sequence,
    sourceMessageId: null,
    createdAt: startedAt
  })
  return Option.getOrUndefined(origin)
}
