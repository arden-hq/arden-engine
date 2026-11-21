import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import { Effect, Schema } from "effect"
import { SYSTEM_HANDLER_IDS } from "../automations/model.js"
import type {
  AutomationJobHandler,
  AutomationJobPayload,
  AutomationStoreError
} from "../automations/store.js"
import { isUserAutomationPurpose, type JobClassification } from "../job-classification.js"
import type { QueueContext } from "./automation-queue-context.js"
import {
  type StoreOperation,
  type WorkOwner,
  classificationOf,
  storeError
} from "./automation-rows.js"
import type { RunAuthorityState } from "./run-context.js"
import { internalRef } from "./space-jobs.js"

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

const JobHandlerIdSchema = Schema.NullOr(Schema.Literals(SYSTEM_HANDLER_IDS))

export const isJobHandlerId = Schema.is(JobHandlerIdSchema)

export const unknownHandlerMessage = (handler: string | null) =>
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
    case "urgent_events":
      return { handler: id }
  }
}

/**
 * What a claim reads from its owner: what a new attempt is written as, and what
 * the worker is told now. A Task authors none of it, so its side is fixed here.
 */
export interface ClaimedWork {
  readonly job: JobClassification
  readonly name: string
  readonly model: string | null
  readonly chatKind: "own" | "yours"
  /**
   * The chat set on the owner now; for a Task or a review, its private chat.
   * Null when it has none.
   */
  readonly chatId: string | null
  /** The handler set now. A reclaimed attempt runs it too, as before. */
  readonly handler: string | null
  readonly ref: string
  readonly contextMode: AutomationContextMode
  readonly cooldownMinutes: number | null
  readonly instructionRevisionId: number | null
  /** An Automation's worker hold. A Task's or a review's is on its queue row. */
  readonly heldSince: string | null
}

export const claimedWork = (owner: WorkOwner): ClaimedWork => {
  switch (owner.kind) {
    case "task":
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
    case "space_review": {
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
    case "automation": {
      const { authored } = owner
      // Only a user's Automation can be set on a chat that is not its own. A
      // run that goes on from such a chat works in a copy of it.
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
