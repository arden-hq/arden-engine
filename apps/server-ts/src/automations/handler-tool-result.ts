import { Effect, Schema } from "effect"
import type {
  AutomationQueue,
  HandlerToolName,
  TerminalAutomationChatRun
} from "../persistence/automations/queue.js"
import type { AutomationJobResult, AutomationStoreError } from "../persistence/automations/store.js"
import { jobResult } from "./runner.js"

type HandlerRead<A> =
  | { readonly kind: "ended"; readonly result: AutomationJobResult }
  | { readonly kind: "made"; readonly value: A }

export const readHandlerRun = Effect.fn("Automation.readHandlerRun")(function* <A>(
  queue: Pick<AutomationQueue["Service"], "handlerToolResult">,
  input: {
    readonly observed: TerminalAutomationChatRun & { readonly runId: string }
    readonly run: { readonly chatRunId: string; readonly chatSessionId: string }
    readonly tool: HandlerToolName
    readonly schema: Schema.ConstraintDecoder<A>
    readonly missing: string
  }
): Effect.fn.Return<HandlerRead<A>, AutomationStoreError | Schema.SchemaError> {
  const { observed, run } = input
  if (observed.status !== "completed")
    return ended(jobResult.failed(observed.error, observed.result, run))
  if (observed.blocked !== null)
    return ended(jobResult.blocked(observed.blocked, observed.result, run))
  const content = yield* queue.handlerToolResult({ runId: observed.runId, tool: input.tool })
  if (content !== undefined) {
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.schema))(content)
    return { kind: "made", value }
  }
  if (observed.noChange !== null)
    return ended(jobResult.completed("no_change", observed.noChange, run))
  return ended(jobResult.failed(input.missing, observed.result, run))
})

const ended = <A>(result: AutomationJobResult): HandlerRead<A> => ({ kind: "ended", result })
