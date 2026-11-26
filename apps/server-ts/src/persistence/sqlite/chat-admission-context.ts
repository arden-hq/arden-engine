import { readDefaultApprovalMode } from "./default-approval-mode.js"
import { Effect } from "effect"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { ChatWriteConflictError, type ChatWriteReceiveInput } from "../chat/store.js"
import type { ModelCatalog } from "../../models/catalog.js"
import type { IntelligenceSettingsStore, LimitSettingsStore } from "../settings/store.js"
import type { ChatRules } from "../chat/rules.js"
import { chatAdmissionInputSchema } from "./chat-admission-input.js"
import { JsonObjectSchema } from "../json.js"
import { validateInput, writeError } from "./chat-write-errors.js"
import { loadReceipt } from "./chat-admission-receipt.js"
import { encodeJson } from "./json.js"
import { type PersistenceDeps } from "./deps.js"

export const transcriptChanged = { type: "transcript_changed" } satisfies ChatProjectionEvent

export const DELIVERY_TARGET = { session: "session", run: "run" } as const

export type DeliveryTarget =
  | { readonly kind: typeof DELIVERY_TARGET.session; readonly sessionId: string }
  | { readonly kind: typeof DELIVERY_TARGET.run; readonly runId: string }

export interface AdmissionDeps {
  readonly sql: PersistenceDeps["writer"]["sql"]
  readonly chatEvents: PersistenceDeps["chatEvents"]
  readonly sessionEvents: PersistenceDeps["sessionEvents"]
  readonly catalog: ModelCatalog["Service"]
  readonly intelligence: IntelligenceSettingsStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly rules: ChatRules["Service"]
}

export const admissionContext = Effect.fn("SqliteChatWriteStore.admissionContext")(function* (
  deps: AdmissionDeps,
  input: ChatWriteReceiveInput
) {
  const { sql, sessionEvents, catalog } = deps
  const valid = yield* validateInput(chatAdmissionInputSchema, input, "start")
  const conflict = (message: string, kind?: "session_busy" | "task_idle" | "queue_changed") =>
    new ChatWriteConflictError({
      sessionId: valid.sessionId,
      clientId: valid.clientId,
      message,
      ...(kind === undefined ? {} : { kind })
    })
  const capture = valid.capture
  const journalCapture =
    capture === undefined
      ? Effect.void
      : sessionEvents.appendEventInTransaction({
          type: "capture_arrived",
          session_id: valid.sessionId,
          client_id: valid.clientId,
          via: capture.via,
          note: capture.note,
          screenshot: capture.screenshot,
          produced_by: null,
          chain_depth: 0
        })
  const automationRun =
    valid.automation === undefined ||
    valid.automationPrompt === undefined ||
    valid.automationContextMode === undefined
      ? undefined
      : {
          ...valid.automation,
          prompt: valid.automationPrompt,
          contextMode: valid.automationContextMode
        }
  const priorReceipt = yield* loadReceipt(
    sql,
    valid.sessionId,
    valid.clientId,
    valid.requestHash,
    valid.message
  )
  const runtime =
    priorReceipt === null
      ? yield* catalog.runtime().pipe(
          Effect.mapError((cause) =>
            writeError("start", "storage", "Could not load the model catalog", {
              sessionId: valid.sessionId,
              cause
            })
          )
        )
      : null
  const { sessionId } = valid
  const approvalMode =
    valid.approvalMode ??
    (yield* readDefaultApprovalMode(sql).pipe(
      Effect.mapError((cause) =>
        writeError("start", "storage", "No default mode", { sessionId, cause })
      )
    ))
  const runMetadata = yield* encodeJson(JsonObjectSchema, {
    turn_id: valid.message.message_id,
    ...(valid.outputSchema === undefined ? {} : { output_schema: valid.outputSchema }),
    ...(automationRun === undefined
      ? {}
      : {
          automation: {
            task_id: automationRun.automationId,
            name: automationRun.name,
            prompt: automationRun.prompt,
            context_mode: automationRun.contextMode
          }
        })
  }).pipe(
    Effect.mapError((cause) =>
      writeError("start", "invalid", "Chat run metadata cannot be encoded", {
        sessionId: valid.sessionId,
        cause
      })
    )
  )
  return { valid, conflict, journalCapture, automationRun, runtime, approvalMode, runMetadata }
})

export type AdmissionContext = Effect.Success<ReturnType<typeof admissionContext>>
