import { ToolExecutionError } from "@arden-hq/loop"
import { sha256Hex } from "@arden-hq/std/hash"
import { canonicalJson } from "@arden-hq/std/json"
import { Schema } from "effect"
import { DIRECTION_REVIEW_HOST } from "../tools/mutation-receipt.js"
import type { ContractLine } from "./contract.js"

export interface TaskDirection {
  readonly itemId: string
  readonly text: string
  readonly body: string | undefined
  readonly lines: ReadonlyArray<ContractLine>
}

export const TaskDirectionReceiptSchema = Schema.Struct({
  item_id: Schema.NonEmptyString,
  digest: Schema.NonEmptyString
})
export type TaskDirectionReceipt = typeof TaskDirectionReceiptSchema.Type

export const taskDirectionReceipt = (direction: TaskDirection): TaskDirectionReceipt => ({
  item_id: direction.itemId,
  digest: sha256Hex(
    canonicalJson({
      item_id: direction.itemId,
      text: direction.text,
      body: direction.body ?? null,
      lines: direction.lines.map((line) => ({
        line_id: line.lineId,
        kind: line.kind,
        text: line.text,
        rejected: line.kind === "decision" ? (line.rejected ?? null) : null
      }))
    })
  )
})

export type ToolCallPlan =
  | { readonly kind: "turn"; readonly shown: TaskDirectionReceipt | undefined }
  | { readonly kind: "call"; readonly toolCallId: string }

export const sameDirection = (a: TaskDirectionReceipt, b: TaskDirectionReceipt): boolean =>
  a.item_id === b.item_id && a.digest === b.digest

export const taskDirectionReview = (): ToolExecutionError =>
  new ToolExecutionError(
    "This call was not started: its Task's goal, details or contract changed after it was planned. Read the Task as it is now in the runtime context, then decide again.",
    { preview: "Not run: the Task changed", retryable: true, host: DIRECTION_REVIEW_HOST }
  )

export class TaskDirectionChanged extends Schema.TaggedError<TaskDirectionChanged>()(
  "TaskDirectionChanged",
  { message: Schema.String }
) {}
