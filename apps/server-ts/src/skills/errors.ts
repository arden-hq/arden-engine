import { Schema } from "effect"

export const SKILL_OPERATION = {
  list: "list",
  content: "content",
  create: "create",
  update: "update",
  marketplace: "marketplace",
  install: "install",
  set_enabled: "set_enabled",
  remove: "remove"
} as const

const SkillOperationSchema = Schema.Literals(Object.values(SKILL_OPERATION))

export type SkillOperation = typeof SkillOperationSchema.Type

export const SKILL_ERROR_REASON = {
  invalid: "invalid",
  not_found: "not_found",
  storage: "storage",
  unavailable: "unavailable"
} as const

export class SkillError extends Schema.TaggedError<SkillError>()("SkillError", {
  operation: SkillOperationSchema,
  reason: Schema.Literals(Object.values(SKILL_ERROR_REASON)),
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
