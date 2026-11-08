import { Schema } from "effect"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { CommandPolicyRuleSchema, type CommandPolicyRule } from "./command-policy.js"
import { RuleSubjectSchema, type RuleDecision, type RuleList, type RuleSubject } from "./rules.js"

export const OfferChoiceSchema = Schema.Struct({
  id: Schema.Literals(["chat", "space", "automation", "system", "everywhere"]),
  principal: Schema.NullOr(Schema.String),
  label: Schema.String,
  detail: Schema.String
})
export type OfferChoice = typeof OfferChoiceSchema.Type

export const PermissionChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    decision: Schema.Literals(["approve", "ask", "deny"])
  }),
  Schema.Struct({
    kind: Schema.Literal("site"),
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  }),
  Schema.Struct({
    kind: Schema.Literal("connector"),
    server: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  }),
  Schema.Struct({ kind: Schema.Literal("mode"), mode: ApprovalModeSchema }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    rules: Schema.Array(CommandPolicyRuleSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16)
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("words"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
    decision: Schema.Literals(["allow", "ask", "never"]),
    rules: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          subject: RuleSubjectSchema,
          decision: Schema.Literals(["allow", "ask", "never"])
        })
      ).check(Schema.isMaxLength(16))
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("path"),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
    access: Schema.Literals(["read", "change"]),
    decision: Schema.Literals(["allow", "never"])
  }),
  Schema.Struct({
    kind: Schema.Literal("rule"),
    ruleId: Schema.NonEmptyString,
    decision: Schema.Literals(["allow", "ask", "never", "remove"])
  })
])
export type PermissionChange = typeof PermissionChangeSchema.Type

export const changeJson = (change: PermissionChange): string => {
  switch (change.kind) {
    case "tool":
      return JSON.stringify({ kind: change.kind, tool: change.tool, decision: change.decision })
    case "site":
      return JSON.stringify({ kind: change.kind, tool: change.tool, origin: change.origin })
    case "connector":
      return JSON.stringify({ kind: change.kind, server: change.server })
    case "mode":
      return JSON.stringify({ kind: change.kind, mode: change.mode })
    case "command":
      return JSON.stringify({
        kind: change.kind,
        rules: change.rules.map((rule) => ({
          executable_path: rule.executable_path,
          argument_prefix: rule.argument_prefix,
          display_prefix: rule.display_prefix
        }))
      })
    case "words":
      return JSON.stringify({
        kind: change.kind,
        text: change.text,
        decision: change.decision,
        rules: change.rules
      })
    case "rule":
      return JSON.stringify({ kind: change.kind, ruleId: change.ruleId, decision: change.decision })
    case "path":
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
    kind: "command",
    executable: rule.executable_path,
    argumentPrefix: rule.argument_prefix
  }))

export const allowSubjects = (
  change: PermissionChange,
  serverName: string | null
): ReadonlyArray<RuleSubject> | undefined => {
  switch (change.kind) {
    case "tool":
      return change.decision === "approve"
        ? [{ kind: "tool", tool: change.tool, server: serverName }]
        : undefined
    case "site":
      return [{ kind: "site", tool: change.tool, origin: change.origin }]
    case "connector":
      return [{ kind: "connector", server: change.server }]
    case "command":
      return commandSubjects(change.rules)
    case "path":
      return change.decision === "allow"
        ? [{ kind: "path", path: change.path, access: change.access }]
        : undefined
    case "mode":
    case "words":
    case "rule":
      return undefined
  }
}

export const offerChoiceList = (choice: OfferChoice): RuleList | undefined => {
  switch (choice.id) {
    case "everywhere":
      return { kind: "global" }
    case "system":
      return { kind: "system" }
    case "space":
      return choice.principal?.startsWith("space:") === true
        ? { kind: "space", spaceId: choice.principal.slice("space:".length) }
        : undefined
    case "chat":
    case "automation":
      return undefined
  }
}

export type RuleChange = RuleDecision | "remove"

export type OfferSource = { readonly kind: "message" } | { readonly kind: "approvals" }

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

export interface OfferHistory {
  readonly approvals: number
  readonly offer: "none" | "open" | "declined" | "saved"
}
