import {
  LOCAL_INSTRUCTION_STATUS,
  RUN_CLIENT,
  RUN_EVENTS_SEEN,
  RUN_FAILURE,
  RUN_MODEL,
  RUN_REASONING,
  RUN_RESULT,
  RUN_STOP_REASON,
  isActiveRunStatus,
  type RunDetail,
  type RunLocalInstructionSource,
  type RunMemoryContext,
  type RunResultState,
  type RunTerminalResult
} from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type { HttpApiError } from "effect/unstable/httpapi"
import type { ChatRunRecord } from "../../persistence/runs/model.js"
import {
  StoredRunTerminalResultSchema,
  wireRunTerminalResult
} from "../../persistence/runs/stored-result.js"
import { failInternal } from "../errors.js"

const storedPlace = { root: Schema.String, path: Schema.String, scope: Schema.String }

const StoredLocalInstructionsSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({
      ...storedPlace,
      status: Schema.Literals([
        LOCAL_INSTRUCTION_STATUS.loaded,
        LOCAL_INSTRUCTION_STATUS.truncated
      ]),
      digest: Schema.String
    }),
    Schema.Struct({
      ...storedPlace,
      status: Schema.Literals([LOCAL_INSTRUCTION_STATUS.empty, LOCAL_INSTRUCTION_STATUS.unreadable])
    })
  ])
)

const decodeStored = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], HttpApiError.InternalServerError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.catch(failInternal("Runs")))

const resultState = (
  result: RunTerminalResult | undefined,
  lateAt: string | undefined
): RunResultState => {
  if (result === undefined) return { kind: RUN_RESULT.none }
  return lateAt === undefined
    ? { kind: RUN_RESULT.on_time, result }
    : { kind: RUN_RESULT.late, result, at: lateAt }
}

export const runDetail = Effect.fn("RunHandlers.runDetail")(function* (
  run: ChatRunRecord,
  memoryContext: ReadonlyArray<RunMemoryContext>
): Effect.fn.Return<RunDetail, HttpApiError.InternalServerError> {
  const storedResult = run.metadata.terminal_result
  const result =
    storedResult === undefined || storedResult === null
      ? undefined
      : wireRunTerminalResult(yield* decodeStored(StoredRunTerminalResultSchema, storedResult))
  const storedLate = run.metadata.late_result_at
  const lateAt =
    storedLate === undefined || storedLate === null
      ? undefined
      : yield* decodeStored(Schema.String, storedLate)
  const localInstructions =
    run.metadata.local_instructions === undefined
      ? []
      : (yield* decodeStored(StoredLocalInstructionsSchema, run.metadata.local_instructions)).map(
          (source): RunLocalInstructionSource => source
        )
  const fields = {
    version: 1 as const,
    run_id: run.runId,
    session_id: run.sessionId,
    turn_id: run.turnId,
    started_at: DateTime.formatIso(run.startedAt),
    updated_at: DateTime.formatIso(run.updatedAt),
    events:
      run.lastSequence === null
        ? { kind: RUN_EVENTS_SEEN.none }
        : { kind: RUN_EVENTS_SEEN.through, sequence: run.lastSequence },
    model:
      run.modelId === null
        ? { kind: RUN_MODEL.unrecorded }
        : { kind: RUN_MODEL.model, model_id: run.modelId },
    reasoning:
      run.reasoningEffort === null
        ? { kind: RUN_REASONING.default }
        : { kind: RUN_REASONING.effort, effort: run.reasoningEffort },
    client:
      run.clientId === null
        ? { kind: RUN_CLIENT.none }
        : { kind: RUN_CLIENT.client, client_id: run.clientId },
    local_instructions: localInstructions,
    memory_context: memoryContext
  } as const
  const status = run.status
  if (isActiveRunStatus(status)) return { ...fields, status }
  if (run.endedAt === null) return yield* failInternal("Runs")(new Error("Ended Run without end"))
  return {
    ...fields,
    status,
    ended_at: DateTime.formatIso(run.endedAt),
    stop_reason:
      run.stopReason === null
        ? { kind: RUN_STOP_REASON.unstated }
        : { kind: RUN_STOP_REASON.stated, reason: run.stopReason },
    result: resultState(result, lateAt),
    failure:
      run.errorCode === null || run.errorMessage === null
        ? { kind: RUN_FAILURE.none }
        : { kind: RUN_FAILURE.failed, code: run.errorCode, message: run.errorMessage }
  }
})
