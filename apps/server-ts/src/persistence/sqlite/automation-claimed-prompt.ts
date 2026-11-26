import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import { cutText } from "@arden-hq/std/text"
import { AUTOMATION_CONTEXT_MODE, type AutomationContextMode } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import { AUTOMATION_JOB_PROMPT, type AutomationJobPrompt } from "../automations/job-prompt.js"
import { readSpaceReviewContext, readTaskWorkerContext } from "./space-job-context.js"
import type { AutomationStoreError } from "../automations/store.js"
import type { WorkOwner } from "./automation-rows.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { causingAutomation } from "./run-cause.js"

export type ClaimedPrompt = (
  owner: WorkOwner,
  contextMode: AutomationContextMode,
  triggerContext: string | undefined
) => Effect.Effect<AutomationJobPrompt, AutomationStoreError | SqlError.SqlError>

export const makeClaimedPrompt = (sql: SqlClient.SqlClient): ClaimedPrompt => {
  const authoredPrompt = Effect.fn("SqliteAutomationStore.authoredPrompt")(function* (
    owner: Extract<WorkOwner, { readonly kind: "automation" }>,
    contextMode: AutomationContextMode,
    triggerContext: string | undefined
  ) {
    const text = owner.authored.prompt
    if (contextMode !== AUTOMATION_CONTEXT_MODE.fresh)
      return {
        kind: AUTOMATION_JOB_PROMPT.text,
        text,
        triggerContext
      } satisfies AutomationJobPrompt
    const cards = yield* sql<{
      readonly count: number
      readonly run_id: string
      readonly tool_call_id: string
      readonly tool_name: string
      readonly preview: string | null
      readonly arguments_json: string
    }>`
      SELECT COUNT(*) OVER () AS count, card.run_id, card.tool_call_id,
        card.tool_name, card.preview, call.arguments_json
      FROM (${pendingDecisionCards(sql)}) AS card
      JOIN chat_runs AS run ON run.run_id = card.run_id
      JOIN tool_calls AS call ON call.run_id = card.run_id
        AND call.tool_call_id = card.tool_call_id
      WHERE ${causingAutomation(sql, "run")} = ${owner.key}
      ORDER BY card.requested_at, card.run_id, card.tool_call_id
      LIMIT 32
    `
    const pendingContext =
      cards.length === 0
        ? ""
        : `\n\nExisting requests waiting for the user's decision (${cards[0]?.count ?? cards.length} total). These cards are context, not permission. Refer to an existing card by its exact run and call IDs; do not repeat its pending action.\n${cards
            .map(
              (card) =>
                `- run ${card.run_id}, call ${card.tool_call_id}, tool ${card.tool_name}, preview ${JSON.stringify(card.preview)}, arguments ${cutText(card.arguments_json, 2_048, { suffix: " [arguments truncated]" })}`
            )
            .join(
              "\n"
            )}${cards[0] !== undefined && cards[0].count > cards.length ? "\nMore pending cards remain unresolved." : ""}`
    return {
      kind: AUTOMATION_JOB_PROMPT.text,
      text: `${text}${pendingContext}`,
      triggerContext
    } satisfies AutomationJobPrompt
  })

  return Effect.fn("SqliteAutomationStore.claimedPrompt")(function* (
    owner: WorkOwner,
    contextMode: AutomationContextMode,
    triggerContext: string | undefined
  ) {
    switch (owner.kind) {
      case JOB_SUBJECT_KIND.task:
        return {
          kind: AUTOMATION_JOB_PROMPT.spaceJob,
          context: {
            kind: "task_execution",
            task: yield* readTaskWorkerContext(sql, owner.itemId)
          },
          triggerContext
        } satisfies AutomationJobPrompt
      case JOB_SUBJECT_KIND.spaceReview:
        return {
          kind: AUTOMATION_JOB_PROMPT.spaceJob,
          context: {
            kind: "space_review",
            space: yield* readSpaceReviewContext(sql, owner.spaceId)
          },
          triggerContext
        } satisfies AutomationJobPrompt
      case JOB_SUBJECT_KIND.automation:
        return yield* authoredPrompt(owner, contextMode, triggerContext)
    }
  })
}
