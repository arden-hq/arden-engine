import { Schema } from "effect"
import { CHAT_MESSAGE_MAX_LENGTH } from "./contracts.js"
import { IMAGE_MEDIA_TYPE } from "./history.js"
import { nonRelativePathSegment } from "../common/routes.js"

export const ImageMediaTypeSchema = Schema.Literals(Object.values(IMAGE_MEDIA_TYPE))
export const ImageDataSchema = Schema.String.check(Schema.isMinLength(1), Schema.isBase64())
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
