import { Schema } from "effect"

const SkillOperationSchema = Schema.Literals([
  "list",
  "content",
  "create",
  "update",
  "marketplace",
  "install",
  "set_enabled",
  "remove"
] as const)

export type SkillOperation = typeof SkillOperationSchema.Type

export class SkillError extends Schema.TaggedError<SkillError>()("SkillError", {
  operation: SkillOperationSchema,
  reason: Schema.Literals(["invalid", "not_found", "storage", "unavailable"] as const),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const skillError = (
  operation: SkillOperation,
  reason: SkillError["reason"],
  message: string,
  cause?: unknown
): SkillError =>
  new SkillError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })
