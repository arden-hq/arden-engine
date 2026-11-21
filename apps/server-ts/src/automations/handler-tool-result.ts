import { Effect, Schema } from "effect"
import type { AutomationQueue, HandlerToolName } from "../persistence/automations/queue.js"

export const handlerToolResult = Effect.fn("Automation.handlerToolResult")(function* <A>(
  queue: Pick<AutomationQueue["Service"], "handlerToolResult">,
  input: {
    readonly runId: string
    readonly tool: HandlerToolName
    readonly schema: Schema.ConstraintDecoder<A>
  }
) {
  const content = yield* queue.handlerToolResult({ runId: input.runId, tool: input.tool })
  if (content === undefined) return undefined
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.schema))(content)
})
