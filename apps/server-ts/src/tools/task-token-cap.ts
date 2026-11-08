import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import type { UpdateSpaceTaskPatch } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"
import type { TaskAddress, WorkStore, WorkStoreError } from "../persistence/work/store.js"
import type { ServerApprovalPrompt } from "./define.js"

const tokenCapWords = (tokenBudget: number | null): string =>
  tokenBudget === null ? "no token cap" : countOf(tokenBudget, "token")

const capRaised = (current: number | null, next: number | null): boolean =>
  current !== null && (next === null || next > current)

export const refuseCapChange = (patch: UpdateSpaceTaskPatch, fromWorker: boolean): void => {
  if (Object.keys(patch).length > 1)
    throw new ToolExecutionError("Change the Task's token cap alone, in its own task_update call", {
      preview: "Separate cap change",
      retryable: true
    })
  if (fromWorker)
    throw new ToolExecutionError(
      "A Task's cap is the user's: a job or a Task's own run never changes it. Raise it with task_comment instead.",
      { preview: "Cap not set", retryable: false }
    )
}

export const tokenBudgetCard = (
  work: WorkStore["Service"],
  address: TaskAddress,
  input: { readonly key: string; readonly cap: number | null }
): Effect.Effect<ServerApprovalPrompt | undefined, WorkStoreError> =>
  work.get(address).pipe(
    Effect.map((task): ServerApprovalPrompt | undefined => {
      if (!capRaised(task.token_budget, input.cap)) return undefined
      const cap = tokenCapWords(input.cap)
      return {
        preview: `Token cap: ${cap}`,
        presentation: {
          title:
            input.cap === null
              ? "Remove this Task's token cap?"
              : `Raise this Task's cap to ${cap}?`,
          fields: [{ label: "Task", value: input.key }],
          approve_label: "Set cap",
          reject_label: "Don't set"
        },
        data: { reviewer: "user" }
      }
    })
  )

export const saveCap = (
  work: WorkStore["Service"],
  address: TaskAddress,
  cap: number | null,
  run: { readonly runId: string; readonly toolCallId: string }
) =>
  work
    .get(address)
    .pipe(
      Effect.flatMap((current) =>
        work.update(
          address,
          current.updated_at,
          { token_budget: cap },
          run.runId,
          run.toolCallId,
          "user"
        )
      )
    )
