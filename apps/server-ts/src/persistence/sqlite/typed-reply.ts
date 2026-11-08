import { canDenyApprovalByReply } from "@arden-hq/protocol/chat"
import { ChatWriteConflictError } from "../chat/store.js"
import { makeToolApprovalResolveInTransaction } from "./tool-approval-resolve.js"
import { makeDeferredDecisionInTransaction } from "./deferred-tool-calls.js"
import { visiblePendingDecisionCards } from "./pending-decision-cards.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { PersistenceDeps } from "./deps.js"
import { settleTypedHereInTransaction } from "./focus-choices.js"
import { answerChatTaskQuestionByTypingInTransaction } from "./task-typed-answer.js"

interface TypedInput {
  readonly approvalReply?: { readonly runId: string; readonly toolId: string }
  readonly deliveryId?: string
  readonly automation?: unknown
  readonly modelRole?: string
  readonly announce?: true
  readonly message: { readonly [key: string]: unknown }
}

const isTypedReply = (input: TypedInput): boolean =>
  input.deliveryId === undefined &&
  input.automation === undefined &&
  input.modelRole === undefined &&
  input.announce === undefined &&
  input.message["is_meta"] !== true &&
  input.message["interaction"] === undefined &&
  input.message["from_chat"] === undefined &&
  input.message["sent_from"] === undefined

export const settleTypedReply = Effect.fn("Chat.settleTypedReply")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: PersistenceDeps["chatEvents"]
  readonly input: TypedInput & { readonly sessionId: string; readonly clientId: string }
  readonly now: string
}) {
  if (options.input.approvalReply !== undefined) {
    yield* denyApprovalReplyInTransaction(options)
    return
  }
  if (!isTypedReply(options.input)) return
  yield* settleTypedHereInTransaction(options)
  yield* answerChatTaskQuestionByTypingInTransaction(options)
})

const denyApprovalReplyInTransaction = Effect.fn("Chat.denyApprovalReplyInTransaction")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly input: TypedInput & { readonly sessionId: string; readonly clientId: string }
    readonly now: string
  }) {
    const { sql, input, sessionEvents } = options
    const conflict = (message: string) =>
      new ChatWriteConflictError({ sessionId: input.sessionId, clientId: input.clientId, message })
    const resolveApproval = makeToolApprovalResolveInTransaction({ sql, sessionEvents })
    const decideDeferred = makeDeferredDecisionInTransaction({ sql, sessionEvents })
    const address = input.approvalReply
    if (address === undefined) return
    const visible = yield* sql<{
      readonly source: string
      readonly kind: string
      readonly session_id: string
      readonly action: string
    }>`
  SELECT source, kind, session_id, action FROM (${visiblePendingDecisionCards(sql, input.sessionId)}) AS card
  WHERE card.run_id = ${address.runId} AND card.tool_call_id = ${address.toolId}
`
    const card = visible[0]
    if (card === undefined || card.kind !== "tool_approval" || !canDenyApprovalByReply(card))
      return yield* conflict("The approval shown in this chat is no longer pending")
    if (
      typeof input.message.content !== "string" ||
      !input.message.content.trim() ||
      !isTypedReply(input)
    )
      return yield* conflict("An approval reply requires the person's typed message")
    if (card.source === "deferred") {
      yield* decideDeferred({
        runId: address.runId,
        toolCallId: address.toolId,
        approved: false,
        result: ""
      }).pipe(Effect.mapError((cause) => conflict(cause.message)))
    } else {
      yield* resolveApproval({
        decision: {
          runId: address.runId,
          toolCallId: address.toolId,
          approved: false,
          feedback: card.session_id === input.sessionId ? null : input.message.content.trim(),
          grantStanding: false,
          grantList: undefined,
          attachFolderToSpace: false,
          edits: null,
          alternative: null
        },
        timestamp: options.now,
        approvedFolders: new Map()
      }).pipe(Effect.mapError((cause) => conflict(cause.message)))
    }
  }
)
