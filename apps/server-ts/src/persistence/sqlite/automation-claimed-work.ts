import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import { Effect, Schema } from "effect"
import { SystemHandlerIdSchema } from "../automations/model.js"
import type {
  AutomationJobHandler,
  AutomationJobPayload,
  AutomationStoreError
} from "../automations/store.js"
import { isUserAutomationPurpose, type JobClassification } from "../job-classification.js"
import type { QueueContext } from "./automation-queue-context.js"
import { eventBatchOf } from "./automation-listening.js"
import { eventItemIds } from "../automations/event-batch.js"
import {
  type StoreOperation,
  type WorkOwner,
  classificationOf,
  storeError
} from "./automation-rows.js"
import type { RunAuthorityState } from "./run-context.js"
import { internalRef } from "./space-job-types.js"

const JobChatRunSchema = Schema.NullOr(
  Schema.Struct({
    runId: Schema.NonEmptyString,
    sessionId: Schema.NonEmptyString,
    authority: Schema.Literals(["active", "settling", "revoked"])
  })
)

export const readJobChatRun = Effect.fn("AutomationJob.readChatRun")(function* (
  row:
    | {
        readonly chat_run_id: string | null
        readonly chat_session_id: string | null
        readonly authority: RunAuthorityState | null
      }
    | undefined,
  operation: StoreOperation,
  automationId: string
): Effect.fn.Return<AutomationJobPayload["chatRun"], AutomationStoreError> {
  if (!row)
    return yield* storeError(
      operation,
      "corrupt",
      "The Automation occurrence is missing",
      automationId
    )
  return yield* Schema.decodeUnknownEffect(JobChatRunSchema)(
    row.chat_run_id === null
      ? null
      : { runId: row.chat_run_id, sessionId: row.chat_session_id, authority: row.authority }
  ).pipe(
    Effect.mapError((cause) =>
      storeError(
        operation,
        "corrupt",
        "The Automation Run identity is incomplete",
        automationId,
        cause
      )
    )
  )
})

const JobHandlerIdSchema = Schema.NullOr(SystemHandlerIdSchema)

export const isJobHandlerId = Schema.is(JobHandlerIdSchema)

export const unknownHandlerMessage = (handler: string | null): string =>
  `Unknown Automation handler: ${handler}`

export const readJobHandler = Effect.fn("AutomationJob.readHandler")(function* (
  handler: string | null,
  context: QueueContext,
  operation: StoreOperation,
  automationId: string
): Effect.fn.Return<AutomationJobHandler, AutomationStoreError> {
  if (!isJobHandlerId(handler))
    return yield* storeError(operation, "corrupt", unknownHandlerMessage(handler), automationId)
  return jobHandler(handler, context)
})

export const jobHandler = (
  id: typeof JobHandlerIdSchema.Type,
  context: QueueContext
): AutomationJobHandler => {
  switch (id) {
    case null:
      return context.space_review_input === undefined
        ? { handler: id }
        : { handler: id, spaceReviewInput: context.space_review_input }
    case "home_letter":
      return context.home_letter_input === undefined
        ? { handler: id }
        : { handler: id, homeLetterInput: context.home_letter_input }
    case "memory_capture":
    case "daily_summary":
    case "wiki_maintenance":
      return context.handler_item === undefined
        ? { handler: id }
        : { handler: id, handlerItem: context.handler_item }
    case "managed_history_collection":
    case "chat_summaries":
      return { handler: id }
    case "events":
      return { handler: id, itemIds: eventItemIds(eventBatchOf(context)) }
  }
}

export interface ClaimedWork {
  readonly job: JobClassification
  readonly name: string
  readonly model: string | null
  readonly chatKind: "own" | "yours"
  readonly chatId: string | null
  readonly handler: string | null
  readonly ref: string
  readonly contextMode: AutomationContextMode
  readonly cooldownMinutes: number | null
  readonly instructionRevisionId: number | null
  readonly heldSince: string | null
  readonly jobOwner: Pick<AutomationJobPayload, "automationId" | "taskItemId">
}

const workOf = (owner: WorkOwner): Omit<ClaimedWork, "jobOwner"> => {
  switch (owner.kind) {
    case JOB_SUBJECT_KIND.task:
      return {
        job: classificationOf(owner),
        name: owner.text,
        model: null,
        chatKind: "own",
        chatId: owner.chatId,
        handler: null,
        ref: internalRef(owner.key),
        contextMode: "fresh",
        cooldownMinutes: null,
        instructionRevisionId: null,
        heldSince: null
      }
    case JOB_SUBJECT_KIND.spaceReview: {
      const { settings } = owner
      return {
        job: classificationOf(owner),
        name: owner.name,
        model: settings.model,
        chatKind: "own",
        chatId: owner.chatId,
        handler: null,
        ref: internalRef(owner.key),
        contextMode: settings.contextMode,
        cooldownMinutes: settings.cooldownMinutes,
        instructionRevisionId: null,
        heldSince: null
      }
    }
    case JOB_SUBJECT_KIND.automation: {
      const { authored } = owner
      const chatKind =
        isUserAutomationPurpose(owner.purpose) && authored.chatOrigin !== owner.key
          ? "yours"
          : "own"
      return {
        job: classificationOf(owner),
        name: authored.name,
        model: authored.model,
        chatKind,
        chatId: authored.chatId,
        handler: authored.handler,
        ref: authored.ref,
        contextMode:
          chatKind === "yours" && authored.contextMode === "continue"
            ? "fork"
            : authored.contextMode,
        cooldownMinutes: authored.cooldownMinutes,
        instructionRevisionId: authored.instructionRevisionId,
        heldSince: owner.state.heldSince
      }
    }
  }
}

export const claimedWork = (owner: WorkOwner): ClaimedWork => ({
  ...workOf(owner),
  jobOwner: { automationId: owner.key, taskItemId: "itemId" in owner ? owner.itemId : null }
})
