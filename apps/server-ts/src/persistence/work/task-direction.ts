import { ToolExecutionError } from "@arden-hq/loop"
import { sha256Hex } from "@arden-hq/std/hash"
import { canonicalJson } from "@arden-hq/std/json"
import { Schema } from "effect"
import { DIRECTION_REVIEW_HOST } from "../tools/mutation-receipt.js"
import type { ContractLine } from "./contract.js"

/**
 * What a Task's owner authored for it: its words and its active contract lines.
 * Working state, comments, evidence, schedule and timestamps are not direction, so a
 * change to them never asks a planned call for review.
 */
export interface TaskDirection {
  readonly itemId: string
  readonly text: string
  readonly body: string | undefined
  readonly lines: ReadonlyArray<ContractLine>
}

/**
 * Which direction a turn was shown: the Task and the digest of its direction. A call keeps
 * the receipt of the turn that asked for it. Equal digests mean the direction is unchanged;
 * a different digest means only that it changed, not that the change matters.
 */
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

/** Where a durable call's plan comes from. */
export type ToolCallPlan =
  /** A model turn asked for it; `shown` is the direction that turn was shown, if any. */
  | { readonly kind: "turn"; readonly shown: TaskDirectionReceipt | undefined }
  /**
   * Another call of the same run made it (a Code Mode script, a workflow, a browser
   * procedure, an approved card's follow-up): it keeps that call's stored plan, never a
   * newer one.
   */
  | { readonly kind: "call"; readonly toolCallId: string }

export const sameDirection = (a: TaskDirectionReceipt, b: TaskDirectionReceipt): boolean =>
  a.item_id === b.item_id && a.digest === b.digest

/**
 * What a call planned before its Task's direction changed gets instead of its effect: one
 * structured outcome. Its `host.not_run` makes the mutation receipt a known no-op and
 * makes the next model request show the current direction (loop-runner.ts), so a new
 * call can act. It does not deny anything: an approval the owner gave stays given.
 */
export const taskDirectionReview = (): ToolExecutionError =>
  new ToolExecutionError(
    "This call was not started: its Task's goal, details or contract changed after it was planned. Read the Task as it is now in the runtime context, then decide again.",
    { preview: "Not run: the Task changed", retryable: true, host: DIRECTION_REVIEW_HOST }
  )

/** A Task write a call asked for, refused in its own transaction: the call's plan is stale. */
export class TaskDirectionChanged extends Schema.TaggedError<TaskDirectionChanged>()(
  "TaskDirectionChanged",
  { message: Schema.String }
) {}
