import {
  AnswerBlockStatesSchema,
  SaveAnswerBlockInputSchema,
  SavedAnswerBlockSchema
} from "@arden-hq/protocol/effect/sessions/answer-blocks"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class AnswerBlocksApi extends HttpApiGroup.make("answerBlocks", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/sessions/:sessionId/answer-blocks", {
    params: { sessionId: Schema.NonEmptyString },
    success: AnswerBlockStatesSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.put("save", "/sessions/:sessionId/answer-blocks/:messageId/:blockIndex", {
    params: {
      sessionId: Schema.NonEmptyString,
      messageId: Schema.NonEmptyString,
      blockIndex: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    },
    payload: SaveAnswerBlockInputSchema,
    success: SavedAnswerBlockSchema,
    error: storeErrors
  })
) {}
