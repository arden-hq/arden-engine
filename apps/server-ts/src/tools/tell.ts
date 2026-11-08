import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { toolFailure } from "./tool-failure.js"
import { TELL_TEXT_LIMIT, WorkStore } from "../persistence/work/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { appliedReceipt, inChatTarget } from "./call-receipt.js"

const TellParametersSchema = Schema.Struct({
  text: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(TELL_TEXT_LIMIT)).pipe(
    Schema.annotateEncoded({
      description:
        "One or two plain sentences addressed to the user: what you found or finished. Never name tools, IDs or Arden's internal terms."
    })
  )
})

const makeTellTool = ({
  work,
  sessions
}: {
  readonly work: WorkStore["Service"]
  readonly sessions: SessionQueries["Service"]
}): ServerTool =>
  defineServerTool({
    name: "tell",
    description: [
      "Say something now to the person, or to the agent that started you, while you keep working: a milestone reached or a finding they should hear before you finish.",
      "It goes to the same place your final reply goes.",
      "Do not use it for the final result: your final reply is delivered by itself. Do not use it to ask a question: ask one instead.",
      "Use it rarely; only a few are allowed in one job."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(TellParametersSchema),
    metadata: {
      effect: "run_record",
      outcome: true,
      display_name: "Tell you",
      kind: "tool",
      action: "write",
      source: "_runs",
      changes_state: true,
      target: "reported",
      concurrency_group: "communication",
      destructive: false,
      idempotent: true
    },
    execute: async (input, ctx, effects) => {
      const told = await Effect.runPromise(
        work
          .tell({ runId: ctx.run.runId, toolCallId: ctx.toolCallId, text: input.text })
          .pipe(Effect.mapError((error) => toolFailure(error, "Not told"))),
        { signal: ctx.signal }
      )
      if (told.kind === "refused")
        throw new ToolExecutionError(told.reason, { preview: "Not told", retryable: false })
      effects.applied()
      const chatId = told.chatId
      const header =
        chatId === undefined
          ? null
          : await Effect.runPromise(
              sessions.loadHistoryHeader(chatId).pipe(Effect.orElseSucceed(() => null))
            )
      return {
        result: "Told the user. Carry on with the work.",
        preview: "Told you",
        host: appliedReceipt(
          ctx,
          inChatTarget({
            resourceRef: `tell:${ctx.run.runId}:${told.n}`,
            title: input.text,
            chat: header ?? undefined
          })
        )
      }
    }
  })

export const tellTools = Effect.gen(function* () {
  return [makeTellTool({ work: yield* WorkStore, sessions: yield* SessionQueries })]
})
