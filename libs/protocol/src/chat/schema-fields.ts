import { Schema } from "effect"
import { CHAT_MESSAGE_MAX_LENGTH } from "./contracts.js"
import { nonRelativePathSegment } from "../common/routes.js"

/** Field schemas shared by the Chat wire schemas (schema.ts) and the plain facade codecs (facade-schema.ts). */

export const ImageMediaTypeSchema = Schema.Literals(["image/png", "image/jpeg"] as const)
/** Image bytes arriving from a client: checked as base64 where they enter the server. */
export const ImageDataSchema = Schema.String.check(Schema.isMinLength(1), Schema.isBase64())
/**
 * Image bytes the server serves back on history rows. They passed
 * `ImageDataSchema` on the way in and the server's history projection re-checks
 * each stored block before serving it, so a reader only confirms they are
 * there: the base64 regex costs milliseconds per image on every history read.
 */
export const ServedImageDataSchema = Schema.String.check(Schema.isMinLength(1))
export const chatIdentifier = Schema.String.check(
  nonRelativePathSegment,
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.makeFilter((value) =>
    value.trim() === value ? undefined : "must not have surrounding whitespace"
  )
)
export const chatMessage = Schema.String.check(Schema.isMaxLength(CHAT_MESSAGE_MAX_LENGTH))

export const QuestionAnswerSchema = Schema.Struct({ question_id: Schema.NonEmptyString })
