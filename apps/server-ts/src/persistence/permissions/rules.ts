import {
  PERMISSION_PATH_ACCESS,
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_SUBJECT,
  type WordsRuleReplaces
} from "@arden-hq/protocol/permissions"
import type { ToolApprovalOverride } from "@arden-hq/protocol/tools"
import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const wordsRuleText = (text: string): string => text.replace(/\s+/gu, " ").trim()

export const RULE_REMOVAL = "remove"

export const RuleSubjectSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.tool),
    tool: Name,
    server: Schema.NullOr(Name)
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.site),
    tool: Name,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  }),
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_SUBJECT.connector), server: Name }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.command),
    executable: Schema.NonEmptyString,
    argumentPrefix: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(8))
  }),
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_SUBJECT.hostCommands) }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.path),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
    access: Schema.Literals(Object.values(PERMISSION_PATH_ACCESS))
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.words),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.vaultKey),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    keyId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
  })
])
export type RuleSubject = typeof RuleSubjectSchema.Type

const RuleListSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_LIST.global) }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_LIST.space),
    spaceId: Schema.NonEmptyString
  }),
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_LIST.system) })
])
export type RuleList = typeof RuleListSchema.Type

const RuleDecisionSchema = Schema.Literals(Object.values(PERMISSION_RULE_DECISION))
export type RuleDecision = typeof RuleDecisionSchema.Type

export const RULE_CHANGE = { ...PERMISSION_RULE_DECISION, remove: "remove" } as const
export type RuleChange = (typeof RULE_CHANGE)[keyof typeof RULE_CHANGE]

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

const RULE_OF_SETTING: Readonly<Record<ToolApprovalOverride, RuleDecision>> = {
  approve: PERMISSION_RULE_DECISION.allow,
  ask: PERMISSION_RULE_DECISION.ask,
  deny: PERMISSION_RULE_DECISION.never
}

export const ruleOfSetting = (setting: ToolApprovalOverride): RuleDecision =>
  RULE_OF_SETTING[setting]

export const RULE_SOURCE = {
  card: "card",
  offer: "offer",
  settings: "settings",
  migrated: "migrated"
} as const

const RuleSourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(RULE_SOURCE.card),
    runId: Schema.NonEmptyString,
    toolCallId: Schema.NonEmptyString
  }),
  Schema.Struct({ kind: Schema.Literal(RULE_SOURCE.offer), questionId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal(RULE_SOURCE.settings) }),
  Schema.Struct({ kind: Schema.Literal(RULE_SOURCE.migrated) })
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
  readonly replaces: WordsRuleReplaces
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
      readonly decision: RuleChange
      readonly source: RuleSource
    }) => Effect.Effect<PermissionRule, PermissionRulesError>
  }
>()("@arden-hq/server/persistence/permissions/PermissionRules") {}
