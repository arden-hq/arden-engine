import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import {
  canonicalDisposition,
  SpaceReviewDispositionSchema
} from "../persistence/automations/space-review.js"
import { SpaceReviewStore } from "../persistence/automations/space-review-store.js"
import type { AutomationStoreError } from "../persistence/automations/store.js"
import { toolFailure } from "./tool-failure.js"

const failure = (error: AutomationStoreError): ToolExecutionError =>
  toolFailure(error, "Space review not finished")

const makeSpaceReviewFinishTool = ({
  spaceReviews
}: {
  readonly spaceReviews: SpaceReviewStore["Service"]
}): ServerTool =>
  defineServerTool({
    name: "space_review_finish",
    description:
      "Finish an active Space review. Use changed only after this Run successfully changed, commented on, or saved a result to every listed Task. Use proposed only after this Run offered Task proposals, with every proposal_id task_propose returned, passed verbatim (task-proposal:…). Changed source evidence alone is not a Task change. Use no_change when this Run changed nothing and asked nothing; a refused or reused inference and a call rejected before running changed nothing. Only when a failed write leaves no valid result, call report with event blocked; do not create a Task or question just to satisfy completion. Use needs_user only with active question IDs created by this Run. Call this tool by itself after all other work.",
    parameters: Schema.toStandardSchemaV1(SpaceReviewDispositionSchema),
    metadata: {
      effect: "run_record",
      scopes: ["observer"],
      display_name: "Finish Space review",
      kind: "tool",
      action: "write",
      source: "_runs",
      changes_state: false,
      concurrency_group: null,
      destructive: false,
      default_approval: "approve",
      internal_catalog: true,
      private_scope: "space",
      ends_turn: true
    },
    execute: async (raw, ctx) => {
      const input = canonicalDisposition(raw)
      await Effect.runPromise(
        spaceReviews
          .validateSpaceReviewDisposition(ctx.run.runId, input)
          .pipe(Effect.mapError(failure)),
        { signal: ctx.signal }
      )
      return {
        result: input.summary,
        preview: "Space review finished",
        data: { review: input }
      }
    }
  })

export const spaceReviewFinishTools = Effect.gen(function* () {
  return [makeSpaceReviewFinishTool({ spaceReviews: yield* SpaceReviewStore })]
})
