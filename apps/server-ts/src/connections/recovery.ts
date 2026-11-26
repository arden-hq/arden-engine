import { PauseRequested } from "@arden-hq/loop"
import type {
  AppSettingsTabId,
  ChatProjectionEvent,
  ConnectionAction,
  ConnectionState
} from "@arden-hq/protocol"
import { CONNECTION_ACCOUNT, type RuntimeConnectionSnapshot } from "@arden-hq/protocol/chat"
import {
  AppSettingsTabIdSchema,
  ConnectionActionSchema,
  ConnectionStateSchema
} from "@arden-hq/protocol/effect/common"
import { type Effect, Schema } from "effect"

const boundedString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))

export const CONNECTION_PROVIDER = { google: "google", mcp: "mcp" } as const

export type ConnectionProvider = (typeof CONNECTION_PROVIDER)[keyof typeof CONNECTION_PROVIDER]

const ConnectionProviderSchema = Schema.Literals(Object.values(CONNECTION_PROVIDER))

export const ConnectionRequiredDataSchema = Schema.Struct({
  _tag: Schema.Literal("ConnectionRequired"),
  provider: ConnectionProviderSchema,
  service: boundedString,
  label: boundedString,
  reason: ConnectionStateSchema,
  detail: Schema.String.check(Schema.isMaxLength(4_096)),
  capability: boundedString,
  action: ConnectionActionSchema,
  settings_tab: AppSettingsTabIdSchema,
  required_scopes: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
  ),
  source: Schema.Literals(["recovery", "suggestion"] as const),
  account_ref: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320))
  )
})

export type ConnectionRequiredData = typeof ConnectionRequiredDataSchema.Type

export interface PendingConnectionDecision {
  readonly snapshot: RuntimeConnectionSnapshot
  readonly provider: ConnectionProvider
  readonly service: string
}

export interface RequestConnectionInput {
  readonly provider: ConnectionProvider
  readonly service: string
  readonly label: string
  readonly reason: ConnectionState
  readonly detail: string
  readonly capability: string
  readonly action: ConnectionAction
  readonly settingsTab: AppSettingsTabId
  readonly requiredScopes: ReadonlyArray<string>
  readonly source?: "recovery" | "suggestion"
  readonly accountRef?: string
}

export const CONNECTION_CHECK_FAILURE = {
  rejected: "rejected",
  unavailable: "unavailable",
  storage: "storage"
} as const

export type ConnectionCheckFailure =
  (typeof CONNECTION_CHECK_FAILURE)[keyof typeof CONNECTION_CHECK_FAILURE]

export class ConnectionCheckError extends Schema.TaggedError<ConnectionCheckError>()(
  "ConnectionCheckError",
  {
    reason: Schema.Literals(Object.values(CONNECTION_CHECK_FAILURE)),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type ConnectionCheck = (
  decision: PendingConnectionDecision
) => Effect.Effect<void, ConnectionCheckError>

export const connectionId = (runId: string, toolCallId: string): string =>
  `connection:${runId}:${toolCallId}`

export const isConnectionRequiredData = Schema.is(
  Schema.Struct({
    _tag: ConnectionRequiredDataSchema.fields._tag
  })
)

const DECISION_DELIVERY = { run: "blocking", deferred: "deferred" } as const

export const pendingConnectionDecision = (
  call: { readonly runId: string; readonly sessionId: string; readonly toolCallId: string },
  data: ConnectionRequiredData,
  source: keyof typeof DECISION_DELIVERY
): PendingConnectionDecision => ({
  snapshot: {
    run_id: call.runId,
    session_id: call.sessionId,
    tool_id: call.toolCallId,
    integration_id: data.service,
    connection_id: connectionId(call.runId, call.toolCallId),
    label: data.label,
    reason: data.reason,
    detail: data.detail,
    capability: data.capability,
    action: data.action,
    settings_tab: data.settings_tab,
    required_scopes: data.required_scopes,
    source: data.source,
    decision_delivery: DECISION_DELIVERY[source],
    account:
      data.account_ref === undefined
        ? { kind: CONNECTION_ACCOUNT.default }
        : { kind: CONNECTION_ACCOUNT.account, ref: data.account_ref }
  },
  provider: data.provider,
  service: data.service
})

export const connectionNeededEvent = (
  decision: PendingConnectionDecision,
  decisionRoute: Extract<
    ChatProjectionEvent,
    { readonly type: "connection_needed" }
  >["decision_route"]
): ChatProjectionEvent => {
  const { decision_delivery: _delivery, ...fields } = decision.snapshot
  return { type: "connection_needed", ...fields, decision_route: decisionRoute }
}

export const requestConnection = (input: RequestConnectionInput): PauseRequested => {
  const data: ConnectionRequiredData = {
    _tag: "ConnectionRequired",
    provider: input.provider,
    service: input.service,
    label: input.label,
    reason: input.reason,
    detail: input.detail,
    capability: input.capability,
    action: input.action,
    settings_tab: input.settingsTab,
    required_scopes: [...input.requiredScopes],
    source: input.source ?? "recovery",
    ...(input.accountRef === undefined ? {} : { account_ref: input.accountRef })
  }
  return new PauseRequested("connection", input.detail, {
    preview: `${input.label} needs attention`,
    data
  })
}
