import { countOf } from "@arden-hq/std/count"
import { ANSWER_UI_FENCE } from "@arden-hq/answer-ui/fence"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Predicate, Schema } from "effect"
import { answerBlockBodies } from "@arden-hq/protocol/chat"
import { AnswerBlockStore } from "../persistence/answer-blocks/store.js"
import type { TranscriptMessageRecord } from "../persistence/transcript/model.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { defineServerTool, type ServerTool } from "./define.js"

const LATEST_WINDOW = 100
const MAX_READ_CHARS = 64 * 1024

const ParametersSchema = Schema.Struct({
  message_id: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description:
        "The message that holds the block, as its compact line in the history names it. Omit for the latest answer with a block."
    })
  ),
  block: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "Which block of that message, from 1. Omit for all of them."
    })
  )
})

const messageText = (record: TranscriptMessageRecord): string => {
  const content = record.envelope.content
  if (Predicate.isString(content)) return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(Predicate.isObject)
    .flatMap((part) => (Predicate.isString(part.text) ? [part.text] : []))
    .join("\n\n")
}

const findAnswer = Effect.fn("answerBlockRead.findAnswer")(function* (
  transcript: TranscriptQueries["Service"],
  sessionId: string,
  messageId: string | undefined
) {
  if (messageId === undefined) {
    const page = yield* transcript.conversationPage({
      _tag: "Latest",
      sessionId,
      limit: LATEST_WINDOW
    })
    return page.records.findLast(
      (record) => record.role === "assistant" && messageText(record).includes(ANSWER_UI_FENCE)
    )
  }
  const sequence = yield* transcript.resolveReference(sessionId, messageId)
  if (sequence === null) return undefined
  const page = yield* transcript.page({ _tag: "Around", sessionId, sequence, limit: 1 })
  return page.records.find((record) => record.sequence === sequence && record.role === "assistant")
})

const notFound = (message: string) =>
  new ToolExecutionError(message, { preview: "No block", retryable: false })

const makeAnswerBlockReadTool = (services: {
  readonly transcript: TranscriptQueries["Service"]
  readonly saved: AnswerBlockStore["Service"]
}): ServerTool =>
  defineServerTool({
    name: "answer_block_read",
    description:
      "Read the full source of an earlier interactive block in this chat, and the values the person set on it, to change or reuse it. Older blocks appear in your history as one compact line naming their message_id and block number.",
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Read Interactive Block",
      kind: "tool",
      action: "read",
      approval_preview: "Read an earlier interactive block in this chat.",
      source: "_sessions",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      permissions: ["session"]
    },
    execute: async (input, ctx) => {
      const sessionId = ctx.run.sessionId
      const record = await Effect.runPromise(
        findAnswer(services.transcript, sessionId, input.message_id),
        { signal: ctx.signal }
      )
      if (record === undefined)
        throw notFound(
          input.message_id === undefined
            ? "No recent answer in this chat has an interactive block."
            : `No answer with message_id "${input.message_id}" in this chat.`
        )
      const bodies = answerBlockBodies(messageText(record))
      if (bodies.length === 0) throw notFound("That message has no interactive block.")
      const wanted =
        input.block === undefined
          ? bodies.map((body, index) => ({ body, number: index + 1 }))
          : bodies.flatMap((body, index) =>
              index + 1 === input.block ? [{ body, number: index + 1 }] : []
            )
      if (wanted.length === 0)
        throw notFound(`That message has ${countOf(bodies.length, "block")}.`)
      const saved = await Effect.runPromise(
        services.saved.forMessage(sessionId, record.messageId),
        {
          signal: ctx.signal
        }
      )
      let total = 0
      const shown = wanted.filter(({ body }, index) => {
        total += body.length
        return index === 0 || total <= MAX_READ_CHARS
      })
      const sections = shown.map(({ body, number }) => {
        const values = saved.get(number - 1)
        return [
          `Block ${number} of message ${record.messageId}:`,
          `\`\`\`${ANSWER_UI_FENCE}\n${body}\n\`\`\``,
          values === undefined
            ? "The person has not changed its controls."
            : `Values the person set: ${JSON.stringify(values)}`
        ].join("\n")
      })
      const rest = wanted.length - shown.length
      return {
        result: [
          ...sections,
          ...(rest > 0 ? [`${countOf(rest, "more block")}; read each by its block number.`] : [])
        ].join("\n\n"),
        preview: `${countOf(shown.length, "block")}`
      }
    }
  })

export const answerBlockTools = Effect.gen(function* () {
  return [
    makeAnswerBlockReadTool({
      transcript: yield* TranscriptQueries,
      saved: yield* AnswerBlockStore
    })
  ]
})
