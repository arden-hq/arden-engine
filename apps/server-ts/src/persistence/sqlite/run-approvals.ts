import type { RuleSavedIn, RunApproval, RunApprovalWork } from "@arden-hq/protocol/runs"
import { RuleSavedInSchema, RunOriginSchema } from "@arden-hq/protocol/effect/runs"
import { sanitizeApprovalPresentation } from "@arden-hq/protocol/chat"
import { Effect, Option, Schema } from "effect"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import { grantFolderField } from "../permissions/grant-folder.js"
import { decodeJson } from "./json.js"
import {
  ConnectionRequiredDataSchema,
  isConnectionRequiredData,
  pendingConnectionDecision
} from "../../connections/recovery.js"

export interface ApprovalRow {
  readonly run_id: string
  readonly session_id: string
  readonly destination_session_id: string
  readonly work_json: string | null
  readonly tool_call_id: string
  readonly source?: "run" | "deferred"
  readonly tool_name: string
  readonly action: string
  readonly scope: string
  readonly preview: string | null
  readonly diff: string | null
  readonly requested_at: string
  readonly kind: string
  readonly payload_json: string | null
}

const text = (payload: Readonly<Record<string, unknown>>, field: string): string | null =>
  typeof payload[field] === "string" ? payload[field] : null

export const decodeRunApproval = Effect.fn("decodeRunApproval")(function* (row: ApprovalRow) {
  const payload = yield* decodeJson(JsonObjectSchema, row.payload_json ?? "{}")
  const data = payload.approval_data
  const connectionDecision = isConnectionRequiredData(data)
    ? pendingConnectionDecision(
        { runId: row.run_id, sessionId: row.session_id, toolCallId: row.tool_call_id },
        yield* Schema.decodeUnknownEffect(ConnectionRequiredDataSchema)(data)
      )
    : null
  const connection =
    connectionDecision === null
      ? null
      : {
          ...connectionDecision.snapshot,
          decision_delivery:
            row.source === "deferred" ? ("deferred" as const) : ("blocking" as const)
        }
  const kind = connection ? "integration_connection" : row.kind
  const subject = kind === "subagent_result" ? text(payload, "task") : null
  return {
    at: row.requested_at,
    run_id: row.run_id,
    session_id: row.session_id,
    destination_session_id: row.destination_session_id,
    work: workOf(row.work_json),
    tool_call_id: row.tool_call_id,
    decision_delivery: row.source === "deferred" ? "deferred" : "blocking",
    kind,
    connection,
    tool_name: row.tool_name,
    action: row.action,
    scope: row.scope,
    preview: row.preview,
    diff: row.diff,
    description: text(payload, "description"),
    detail: text(payload, "detail"),
    subject: connection?.label ?? subject,
    reason: connection?.reason ?? null,
    presentation: sanitizeApprovalPresentation(payload.presentation) ?? null,
    rule_places: storedRulePlaces(payload),
    ...(payload.can_attach_folder_to_space === true ? { can_attach_folder_to_space: true } : {}),
    ...grantFolderField(row.tool_name, data)
  } satisfies RunApproval
})

const RulePlacesSchema = Schema.Array(RuleSavedInSchema)

export const storedRulePlaces = (payload: JsonObject): ReadonlyArray<RuleSavedIn> =>
  Option.getOrElse(Schema.decodeUnknownOption(RulePlacesSchema)(payload["rule_places"]), () => [])

export const workOf = (json: string | null): RunApprovalWork | null => {
  const origin = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RunOriginSchema))(json)
  )
  switch (origin?.kind) {
    case "task":
      return { kind: "task", item_id: origin.item_id }
    case "automation":
      return { kind: "automation", automation_id: origin.automation_id }
    case undefined:
    case "chat":
    case "space":
    case "unrecorded":
      return null
  }
}
