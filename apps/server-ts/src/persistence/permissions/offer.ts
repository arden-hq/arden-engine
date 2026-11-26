import { Schema } from "effect"
import {
  PERMISSION_PATH_ACCESS,
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_SUBJECT
} from "@arden-hq/protocol/permissions"
import { TOOL_APPROVAL_OVERRIDE } from "@arden-hq/protocol/tools"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { CommandPolicyRuleSchema, type CommandPolicyRule } from "./command-policy.js"
import { RULE_REMOVAL, RuleSubjectSchema, type RuleList, type RuleSubject } from "./rules.js"

const OFFER_CHOICE = {
  chat: "chat",
  space: "space",
  automation: "automation",
  system: "system",
  everywhere: "everywhere"
} as const

export const OfferChoiceSchema = Schema.Struct({
  id: Schema.Literals(Object.values(OFFER_CHOICE)),
  principal: Schema.NullOr(Schema.String),
  label: Schema.String,
  detail: Schema.String
})
export type OfferChoice = typeof OfferChoiceSchema.Type

export const PERMISSION_CHANGE = {
  tool: "tool",
  site: "site",
  connector: "connector",
  mode: "mode",
  command: "command",
  words: "words",
  path: "path",
  rule: "rule"
} as const

const RuleDecisionSchema = Schema.Literals(Object.values(PERMISSION_RULE_DECISION))

export const PermissionChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.tool),
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    decision: Schema.Literals(Object.values(TOOL_APPROVAL_OVERRIDE))
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.site),
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.connector),
    server: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  }),
  Schema.Struct({ kind: Schema.Literal(PERMISSION_CHANGE.mode), mode: ApprovalModeSchema }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.command),
    rules: Schema.Array(CommandPolicyRuleSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16)
    )
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.words),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
    decision: RuleDecisionSchema,
    rules: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          subject: RuleSubjectSchema,
          decision: RuleDecisionSchema
        })
      ).check(Schema.isMaxLength(16))
    )
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.path),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
    access: Schema.Literals(Object.values(PERMISSION_PATH_ACCESS)),
    decision: Schema.Literals([PERMISSION_RULE_DECISION.allow, PERMISSION_RULE_DECISION.never])
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_CHANGE.rule),
    ruleId: Schema.NonEmptyString,
    decision: Schema.Literals([...Object.values(PERMISSION_RULE_DECISION), RULE_REMOVAL])
  })
])
export type PermissionChange = typeof PermissionChangeSchema.Type

export const changeJson = (change: PermissionChange): string => {
  switch (change.kind) {
    case PERMISSION_CHANGE.tool:
      return JSON.stringify({ kind: change.kind, tool: change.tool, decision: change.decision })
    case PERMISSION_CHANGE.site:
      return JSON.stringify({ kind: change.kind, tool: change.tool, origin: change.origin })
    case PERMISSION_CHANGE.connector:
      return JSON.stringify({ kind: change.kind, server: change.server })
    case PERMISSION_CHANGE.mode:
      return JSON.stringify({ kind: change.kind, mode: change.mode })
    case PERMISSION_CHANGE.command:
      return JSON.stringify({
        kind: change.kind,
        rules: change.rules.map((rule) => ({
          executable_path: rule.executable_path,
          argument_prefix: rule.argument_prefix,
          display_prefix: rule.display_prefix
        }))
      })
    case PERMISSION_CHANGE.words:
      return JSON.stringify({
        kind: change.kind,
        text: change.text,
        decision: change.decision,
        rules: change.rules
      })
    case PERMISSION_CHANGE.rule:
      return JSON.stringify({ kind: change.kind, ruleId: change.ruleId, decision: change.decision })
    case PERMISSION_CHANGE.path:
      return JSON.stringify({
        kind: change.kind,
        path: change.path,
        access: change.access,
        decision: change.decision
      })
  }
}

export const commandSubjects = (
  rules: ReadonlyArray<CommandPolicyRule>
): ReadonlyArray<RuleSubject> =>
  rules.map((rule) => ({
    kind: PERMISSION_RULE_SUBJECT.command,
    executable: rule.executable_path,
    argumentPrefix: rule.argument_prefix
  }))

export const allowSubjects = (
  change: PermissionChange,
  serverName: string | null
): ReadonlyArray<RuleSubject> | undefined => {
  switch (change.kind) {
    case PERMISSION_CHANGE.tool:
      return change.decision === TOOL_APPROVAL_OVERRIDE.approve
        ? [{ kind: PERMISSION_RULE_SUBJECT.tool, tool: change.tool, server: serverName }]
        : undefined
    case PERMISSION_CHANGE.site:
      return [{ kind: PERMISSION_RULE_SUBJECT.site, tool: change.tool, origin: change.origin }]
    case PERMISSION_CHANGE.connector:
      return [{ kind: PERMISSION_RULE_SUBJECT.connector, server: change.server }]
    case PERMISSION_CHANGE.command:
      return commandSubjects(change.rules)
    case PERMISSION_CHANGE.path:
      return change.decision === PERMISSION_RULE_DECISION.allow
        ? [{ kind: PERMISSION_RULE_SUBJECT.path, path: change.path, access: change.access }]
        : undefined
    case PERMISSION_CHANGE.mode:
    case PERMISSION_CHANGE.words:
    case PERMISSION_CHANGE.rule:
      return undefined
  }
}

export const offerChoiceList = (choice: OfferChoice): RuleList | undefined => {
  switch (choice.id) {
    case OFFER_CHOICE.everywhere:
      return { kind: PERMISSION_RULE_LIST.global }
    case OFFER_CHOICE.system:
      return { kind: PERMISSION_RULE_LIST.system }
    case OFFER_CHOICE.space:
      return choice.principal?.startsWith("space:") === true
        ? { kind: PERMISSION_RULE_LIST.space, spaceId: choice.principal.slice("space:".length) }
        : undefined
    case OFFER_CHOICE.chat:
    case OFFER_CHOICE.automation:
      return undefined
  }
}

export const OFFER_SOURCE = { message: "message", approvals: "approvals" } as const

export type OfferSource =
  | { readonly kind: typeof OFFER_SOURCE.message }
  | { readonly kind: typeof OFFER_SOURCE.approvals }

export interface PermissionOfferRecord {
  readonly change: PermissionChange
  readonly serverName: string | null
  readonly source: OfferSource
  readonly choices: ReadonlyArray<OfferChoice>
}

export interface OfferHolders {
  readonly shared: {
    readonly kind: "space"
    readonly principal: string
    readonly name: string
  } | null
}

export const OFFER_HISTORY = {
  none: "none",
  open: "open",
  declined: "declined",
  saved: "saved"
} as const

export interface OfferHistory {
  readonly approvals: number
  readonly offer: (typeof OFFER_HISTORY)[keyof typeof OFFER_HISTORY]
}
