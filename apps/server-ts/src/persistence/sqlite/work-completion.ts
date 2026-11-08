import type { UpdateSpaceTaskPatch } from "@arden-hq/protocol/spaces/work"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { readMutationReceipt, mutationOperationId } from "../tools/mutation-receipt.js"
import { taskFileHref, WorkStoreError } from "../work/store.js"
import { completionReportText } from "./completion-report.js"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"
import { planGaps } from "../todos/items.js"
import { readRunPlan } from "./task-plan.js"
import { metCriteriaWords, unmetCriteria } from "./task-contract.js"

const ResultSchema = Schema.Struct({
  is_error: Schema.optionalKey(Schema.Boolean),
  host: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
})

export const verifyTaskCompletion = Effect.fn("Work.verifyCompletion")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly itemId: string
    readonly runId: string | undefined
    readonly patch: UpdateSpaceTaskPatch
  }): Effect.fn.Return<string, WorkStoreError | SqlError> {
    const { sql, itemId, runId, patch } = options
    if (!patch.completion_result || !patch.completion_evidence?.length) {
      return yield* workError(
        "invalid",
        "Completion needs completion_result and completion_evidence. Save the full report with task_save_result, or cite a confirmed write that fulfills the requested outcome."
      )
    }
    const unmet = yield* unmetCriteria(sql, itemId)
    if (unmet.length > 0)
      return yield* workError(
        "invalid",
        [
          `Not done: ${unmet.length === 1 ? "this done-when criterion has" : `these ${unmet.length} done-when criteria have`} no recorded evidence:`,
          ...unmet.map((line) => `- L${line.line_id}: ${JSON.stringify(line.text)}`),
          "Meet each with task_criterion_met (a tool call of this Task's runs, a file, a saved result or a fetched link), or keep the Task open. Only the owner changes the criteria."
        ].join("\n")
      )
    const labels = yield* Effect.forEach(
      patch.completion_evidence,
      Effect.fn(function* (evidence) {
        if (evidence.kind === "attachment") {
          const rows = yield* sql<{ readonly name: string }>`SELECT name FROM space_task_attachments
        WHERE attachment_id = ${evidence.attachment_id} AND item_id = ${itemId}
          AND size > 0 AND length(data) = size`
          if (!rows[0])
            return yield* workError(
              "invalid",
              "The result file is missing or belongs to another Task. Save this Task's complete report before marking it done."
            )
          const label = `${evidence.description} — ${rows[0].name}`
            .replace(/[\\[\]]/g, "\\$&")
            .replace(/[\r\n]+/g, " ")
          return `[${label}](${taskFileHref(itemId, evidence.attachment_id)})`
        }
        if (runId === undefined)
          return yield* workError("invalid", "Tool evidence requires the current Run.")
        const rows = yield* sql<{
          readonly status: string
          readonly changes_state: number
          readonly result_json: string | null
        }>`
      SELECT status, changes_state, result_json FROM tool_calls
      WHERE run_id = ${runId} AND tool_call_id = ${evidence.tool_call_id}`
        const row = rows[0]
        if (!row || row.status !== "completed" || !row.changes_state || row.result_json === null) {
          return yield* workError(
            "invalid",
            "Completion evidence must identify a confirmed write in this Run. A read or unfinished call does not prove delivery."
          )
        }
        const result = yield* decodeJson(ResultSchema, row.result_json).pipe(
          Effect.mapError((cause) =>
            workError("storage", "Could not read completion evidence", cause)
          )
        )
        const receipt = readMutationReceipt(result.host)
        const operationId = mutationOperationId({ runId, toolCallId: evidence.tool_call_id })
        if (
          result.is_error ||
          !receipt ||
          receipt.outcome === "unknown" ||
          receipt.operation_id !== operationId ||
          receipt.receipt_ref !== operationId
        ) {
          return yield* workError(
            "invalid",
            "That write failed or its outcome is unconfirmed. Preserve the draft with task_save_result; keep the Task open if the requested publication is still missing."
          )
        }
        return evidence.description
      })
    )
    if (runId !== undefined) {
      const failed = yield* sql`SELECT 1 FROM tool_calls WHERE run_id = ${runId}
      AND changes_state = 1 AND status = 'completed' AND json_extract(result_json, '$.is_error') = 1
      AND tool_name NOT IN ('space_task_update', 'task_update', 'task_wait', 'task_finish') LIMIT 1`
      if (failed.length > 0 && !patch.completion_note) {
        return yield* workError(
          "invalid",
          "A write failed during this Run. Supply a brief completion_note explaining its recovery or why it was optional. If required publication remains missing, keep the Task open and save the draft."
        )
      }
    }
    const plan = runId === undefined ? undefined : yield* readRunPlan(sql, runId)
    const criteria = yield* metCriteriaWords(sql, itemId)
    return completionReportText({
      result: patch.completion_result,
      evidence: [
        ...labels,
        ...criteria,
        ...(patch.completion_note === undefined ? [] : [patch.completion_note])
      ],
      gaps: planGaps(plan ?? [])
    })
  },
  Effect.mapError((cause) =>
    cause instanceof WorkStoreError
      ? cause
      : workError("storage", "Could not verify Task completion", cause)
  )
)
