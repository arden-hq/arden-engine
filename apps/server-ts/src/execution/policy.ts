import { GoogleAccountGrantsSchema } from "@arden-hq/protocol/effect/google"
import { Schema, type Effect } from "effect"
import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { TaskInferencePolicySchema } from "@arden-hq/protocol/effect/spaces"

export const RUN_CAPABILITY = {
  none: "none",
  readOnly: "read_only",
  reports: "reports",
  browser: "browser",
  all: "all",
  space: "space",
  memoryCapture: "memory_capture",
  chatSummary: "chat_summary",
  agentResearch: "agent_research",
  agentCode: "agent_code"
} as const
export type RunCapability = (typeof RUN_CAPABILITY)[keyof typeof RUN_CAPABILITY]
export const RunCapabilitySchema = Schema.Literals(Object.values(RUN_CAPABILITY))

export const SessionResourceReachSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  generation: Schema.Natural,
  capabilities: Schema.NonEmptyArray(RunCapabilitySchema),
  authority_session_id: Schema.NonEmptyString,
  authority_generation: Schema.Natural
})
export type SessionResourceReach = typeof SessionResourceReachSchema.Type

export const TOOL_SCOPE_KEY = { ...RUN_CAPABILITY, worker: "worker", observer: "observer" } as const
export type ToolScopeKey = (typeof TOOL_SCOPE_KEY)[keyof typeof TOOL_SCOPE_KEY]
export const SCOPE_KEYS: ReadonlyArray<ToolScopeKey> = Object.values(TOOL_SCOPE_KEY)

export const runApprovalMode = (policy: {
  readonly auto_approve: boolean
  readonly approval_mode?: ApprovalMode
}): ApprovalMode => policy.approval_mode ?? (policy.auto_approve ? "allow" : "ask")

export const RUN_EXECUTION_MODE = { inline: "inline", worker: "worker" } as const

export const RunPolicySchema = Schema.Struct({
  authority_session_id: Schema.optionalKey(Schema.NonEmptyString),
  authority_generation: Schema.optionalKey(Schema.Natural),
  automation_id: Schema.optionalKey(Schema.NonEmptyString),
  automation_instruction_revision_id: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  budget_id: Schema.NonEmptyString,
  budget_generation: Schema.optionalKey(Schema.Natural),
  execution: Schema.Struct({
    mode: Schema.Literals(Object.values(RUN_EXECUTION_MODE)),
    observe: Schema.Boolean
  }),
  capabilities: Schema.NonEmptyArray(RunCapabilitySchema),
  auto_approve: Schema.Boolean,
  approval_mode: Schema.optionalKey(ApprovalModeSchema),
  google_accounts: Schema.NullOr(GoogleAccountGrantsSchema),
  resource_sessions: Schema.optionalKey(Schema.Array(SessionResourceReachSchema)),
  space: Schema.NullOr(
    Schema.Struct({
      space_id: Schema.NonEmptyString,
      generation: Schema.Natural,
      inference: TaskInferencePolicySchema
    })
  )
})
export type RunPolicy = typeof RunPolicySchema.Type

export const runPolicyOf = (
  record: { readonly metadata: Readonly<Record<string, unknown>> } | null
): Effect.Effect<RunPolicy, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RunPolicySchema)(record?.metadata["run_policy"])

export const narrowCapabilities = (
  requested: RunCapability,
  inherited: RunPolicy["capabilities"]
): RunPolicy["capabilities"] => [
  requested,
  ...inherited.filter(
    (capability) =>
      capability !== requested &&
      (requested === RUN_CAPABILITY.all || capability !== RUN_CAPABILITY.all)
  )
]

export const meetCapabilities = (
  left: RunPolicy["capabilities"],
  right: RunPolicy["capabilities"]
): RunPolicy["capabilities"] =>
  right.reduce((held, capability) => narrowCapabilities(capability, held), left)

export const runAuthorityChat = (
  policy: Pick<RunPolicy, "authority_session_id">,
  sessionId: string
): string => policy.authority_session_id ?? sessionId
