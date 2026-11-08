import type { SavedAnswerBlock } from "@arden-hq/protocol/sessions/answer-blocks"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  AnswerBlockStore,
  type SavedAnswerBlockRecord
} from "../../persistence/answer-blocks/store.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

const toWire = (block: SavedAnswerBlockRecord): SavedAnswerBlock => ({
  message_id: block.messageId,
  block_index: block.blockIndex,
  state: block.state
})

export const AnswerBlockHandlers = HttpApiBuilder.group(
  ArdenApi,
  "answerBlocks",
  Effect.fn("AnswerBlockHandlers")(function* (handlers) {
    const blocks = yield* AnswerBlockStore
    return handlers
      .handle("list", ({ params }) =>
        blocks.list(params.sessionId).pipe(
          Effect.map((saved) => ({ blocks: saved.map(toWire) })),
          Effect.catch(failStore)
        )
      )
      .handle("save", ({ params, payload }) =>
        blocks
          .save({
            sessionId: params.sessionId,
            messageId: params.messageId,
            blockIndex: params.blockIndex,
            state: payload.state
          })
          .pipe(Effect.map(toWire), Effect.catch(failStore))
      )
  })
)
