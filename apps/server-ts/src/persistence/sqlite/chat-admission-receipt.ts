import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatReceiptStatus } from "@arden-hq/protocol/chat"
import { ChatReceiptStatusSchema } from "@arden-hq/protocol/effect/chat"
import { ChatWriteConflictError, type ChatWriteError } from "../chat/store.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { workflowDeliveryClientId } from "../chat/workflow-delivery.js"
import { writeError } from "./chat-write-errors.js"
import { decodeJson } from "./json.js"

interface ReceiptRow {
  readonly request_hash: string
  readonly run_id: string | null
  readonly status: string
  readonly message_json: string | null
}

interface LoadedReceipt extends Omit<ReceiptRow, "run_id" | "status"> {
  readonly run_id: string | null
  readonly status: ChatReceiptStatus
}

interface WorkflowDeliveryEnvelopeIdentity {
  readonly workflowRef: string
  readonly attempt: number
}

const workflowDeliveryEnvelopeIdentity = (
  message: StoredMessageEnvelope
): WorkflowDeliveryEnvelopeIdentity | null => {
  if (message.is_meta !== true) return null
  const value = message.workflow_delivery
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const fields = value as Readonly<Record<string, unknown>>
  const workflowRef = fields["workflow_ref"]
  const attempt = fields["attempt"]
  if (
    typeof workflowRef !== "string" ||
    workflowRef.trim().length === 0 ||
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    return null
  return { workflowRef, attempt }
}

export const loadReceipt = Effect.fn("SqliteChatWriteStore.loadReceipt")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  clientId: string,
  requestHash: string,
  incomingMessage: StoredMessageEnvelope
): Effect.fn.Return<LoadedReceipt | null, ChatWriteError | ChatWriteConflictError> {
  const rows = yield* sql<ReceiptRow>`
    SELECT request_hash, run_id, status, message_json
    FROM chat_idempotency_keys
    WHERE session_id = ${sessionId} AND client_id = ${clientId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError("start", "storage", "Could not inspect idempotency receipt", {
        sessionId,
        cause
      })
    )
  )
  const receipt = rows[0]
  if (receipt === undefined) return null
  if (receipt.request_hash !== requestHash) {
    const identity = workflowDeliveryEnvelopeIdentity(incomingMessage)
    const expectedClientId = identity === null ? null : workflowDeliveryClientId(identity)
    const existing =
      receipt.message_json === null
        ? null
        : yield* decodeJson(StoredMessageEnvelopeSchema, receipt.message_json).pipe(
            Effect.mapError((cause) =>
              writeError("start", "corrupt", "Stored Chat idempotency message is corrupt", {
                sessionId,
                cause
              })
            )
          )
    const existingIdentity = existing === null ? null : workflowDeliveryEnvelopeIdentity(existing)
    if (
      identity === null ||
      existingIdentity === null ||
      clientId !== expectedClientId ||
      existingIdentity.workflowRef !== identity.workflowRef ||
      existingIdentity.attempt !== identity.attempt
    ) {
      return yield* new ChatWriteConflictError({
        sessionId,
        clientId,
        message: "The client id was already used for a different request"
      })
    }
  }
  const runId = receipt.run_id
  if ((runId === null && receipt.status !== "accepted") || runId === "") {
    return yield* writeError("start", "corrupt", "Idempotency receipt has no run id", { sessionId })
  }
  const status = yield* Schema.decodeUnknownEffect(ChatReceiptStatusSchema)(receipt.status).pipe(
    Effect.mapError((cause) =>
      writeError("start", "corrupt", "Idempotency receipt status is invalid", {
        sessionId,
        ...(runId === null ? {} : { runId }),
        cause
      })
    )
  )
  return { ...receipt, run_id: runId, status }
})
