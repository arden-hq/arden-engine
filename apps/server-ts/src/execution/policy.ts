import { GoogleAccountGrantsSchema } from "@arden-hq/protocol/effect/google"
import { Schema } from "effect"
import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { TaskInferencePolicySchema } from "@arden-hq/protocol/effect/spaces"

export const RunCapabilitySchema = Schema.Literals([
  "none",
  "read_only",
  "reports",
  "browser",
  "all",
  "space",
  "memory_capture",
  "chat_summary",
  "agent_research",
  "agent_code"
])
export type RunCapability = typeof RunCapabilitySchema.Type

export const SessionResourceReachSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  generation: Schema.Natural,
  capabilities: Schema.NonEmptyArray(RunCapabilitySchema),
  authority_session_id: Schema.NonEmptyString,
  authority_generation: Schema.Natural
})
export type SessionResourceReach = typeof SessionResourceReachSchema.Type

export const SCOPE_KEYS = [...RunCapabilitySchema.literals, "worker", "observer"] as const

export type ToolScopeKey = (typeof SCOPE_KEYS)[number]

export const runApprovalMode = (policy: {
  readonly auto_approve: boolean
  readonly approval_mode?: ApprovalMode
}): ApprovalMode => policy.approval_mode ?? (policy.auto_approve ? "allow" : "ask")

export const RunPolicySchema = Schema.Struct({
  authority_session_id: Schema.optionalKey(Schema.NonEmptyString),
  authority_generation: Schema.optionalKey(Schema.Natural),
  automation_id: Schema.optionalKey(Schema.NonEmptyString),
  automation_instruction_revision_id: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  budget_id: Schema.NonEmptyString,
  budget_generation: Schema.optionalKey(Schema.Natural),
  execution: Schema.Struct({
    mode: Schema.Literals(["inline", "worker"]),
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
) => Schema.decodeUnknownEffect(RunPolicySchema)(record?.metadata["run_policy"])

export const narrowCapabilities = (
  requested: RunCapability,
  inherited: RunPolicy["capabilities"]
): RunPolicy["capabilities"] => [
  requested,
  ...inherited.filter(
    (capability) => capability !== requested && (requested === "all" || capability !== "all")
  )
]

export const meetCapabilities = (
  left: RunPolicy["capabilities"],
  right: RunPolicy["capabilities"]
): RunPolicy["capabilities"] =>
  right.reduce((held, capability) => narrowCapabilities(capability, held), left)
