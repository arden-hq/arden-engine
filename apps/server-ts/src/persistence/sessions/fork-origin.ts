import { Schema } from "effect"
import { SessionForkOriginSchema } from "@arden-hq/protocol/effect/common"
import { isJsonObject } from "../json.js"

export { SessionForkOriginSchema }
export type { SessionForkOrigin } from "@arden-hq/protocol/sessions"

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
  if (current._tag === "Some") return current.value
  const legacy = Schema.decodeUnknownOption(LegacyForkSchema)(
    isJsonObject(metadata) ? metadata.fork_of : undefined
  )
  if (legacy._tag === "None") return undefined
  const origin = Schema.decodeUnknownOption(SessionForkOriginSchema)({
    sourceSessionId: legacy.value.source_session_id,
    sourceSessionRef: null,
    throughSequence: legacy.value.through_sequence,
    sourceMessageId: null,
    createdAt: startedAt
  })
  return origin._tag === "Some" ? origin.value : undefined
}
