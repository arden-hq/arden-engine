import type { ToolApprovalOverride } from "@arden-hq/protocol/tools"
import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const wordsRuleText = (text: string): string => text.replace(/\s+/gu, " ").trim()

export const RuleSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tool"), tool: Name, server: Schema.NullOr(Name) }),
  Schema.Struct({
    kind: Schema.Literal("site"),
    tool: Name,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  }),
  Schema.Struct({ kind: Schema.Literal("connector"), server: Name }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    executable: Schema.NonEmptyString,
    argumentPrefix: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(8))
  }),
  Schema.Struct({ kind: Schema.Literal("host_commands") }),
  Schema.Struct({
    kind: Schema.Literal("path"),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
    access: Schema.Literals(["read", "change"])
  }),
  Schema.Struct({
    kind: Schema.Literal("words"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))
  })
])
export type RuleSubject = typeof RuleSubjectSchema.Type

const RuleListSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("space"), spaceId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("system") })
])
export type RuleList = typeof RuleListSchema.Type

const RuleDecisionSchema = Schema.Literals(["allow", "ask", "never"])
export type RuleDecision = typeof RuleDecisionSchema.Type

export const settingOfRule = (decision: RuleDecision): ToolApprovalOverride => {
  switch (decision) {
    case "allow":
      return "approve"
    case "ask":
      return "ask"
    case "never":
      return "deny"
  }
}

export const ruleOfSetting = (setting: ToolApprovalOverride): RuleDecision => {
  switch (setting) {
    case "approve":
      return "allow"
    case "ask":
      return "ask"
    case "deny":
      return "never"
  }
}

const RuleSourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("card"),
    runId: Schema.NonEmptyString,
    toolCallId: Schema.NonEmptyString
  }),
  Schema.Struct({ kind: Schema.Literal("offer"), questionId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("settings") }),
  Schema.Struct({ kind: Schema.Literal("migrated") })
])
export type RuleSource = typeof RuleSourceSchema.Type

export interface PermissionRule {
  readonly id: string
  readonly subject: RuleSubject
  readonly list: RuleList
  readonly decision: RuleDecision
  readonly source: { readonly kind: RuleSource["kind"]; readonly runId: string | null }
  readonly createdAt: string | null
  readonly fromRuleId: string | null
}

export const RuleInputSchema = Schema.Struct({
  subject: RuleSubjectSchema,
  list: RuleListSchema,
  decision: RuleDecisionSchema,
  source: RuleSourceSchema,
  fromRuleId: Schema.optionalKey(Schema.NonEmptyString)
})
export type RuleInput = typeof RuleInputSchema.Type

export interface WordsInput {
  readonly text: string
  readonly list: RuleList
  readonly decision: RuleDecision
  readonly rules: ReadonlyArray<{ readonly subject: RuleSubject; readonly decision: RuleDecision }>
  readonly source: RuleSource
  readonly replaces?: string
}

export type PermissionRulesOperation = "list" | "save" | "remove"

export class PermissionRulesError extends Schema.TaggedError<PermissionRulesError>()(
  "PermissionRulesError",
  {
    ...storeErrorFields({
      operations: ["list", "save", "remove"],
      reasons: ["invalid", "not_found", "conflict", "storage"]
    })
  }
) {}

export class PermissionRules extends Context.Service<
  PermissionRules,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<PermissionRule>, PermissionRulesError>
    readonly inLists: (
      lists: ReadonlyArray<RuleList>
    ) => Effect.Effect<ReadonlyArray<PermissionRule>, PermissionRulesError>
    readonly save: (input: RuleInput) => Effect.Effect<PermissionRule, PermissionRulesError>
    readonly saveWords: (input: WordsInput) => Effect.Effect<PermissionRule, PermissionRulesError>
    readonly change: (input: {
      readonly ruleId: string
      readonly decision: RuleDecision | "remove"
      readonly source: RuleSource
    }) => Effect.Effect<PermissionRule, PermissionRulesError>
  }
>()("@arden-hq/server/persistence/permissions/PermissionRules") {}
