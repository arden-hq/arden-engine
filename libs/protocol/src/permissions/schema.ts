import { nonRelativePathSegment } from "../common/routes.js"
import { SpaceApprovalModeSchema } from "../spaces/schema.js"
import { Effect, Schema } from "effect"
import type {
  CommandSandboxStatus,
  NewPermissionRule,
  PermissionRuleItem,
  PermissionRuleListResponse,
  PermissionWordsCompiled,
  NewWordsRule,
  CompiledRule,
  PermissionRuleList,
  SessionPermission,
  DefaultApprovalMode
} from "./contracts.js"
import { withExtras } from "../common/schema.js"

const boundedNonEmpty = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))
export const PermissionIdSchema = boundedNonEmpty(128).check(nonRelativePathSegment)

export const CommandSandboxStatusSchema: Schema.Codec<CommandSandboxStatus> = withExtras({
  status: Schema.Literals(["not_linux", "ready", "missing", "no_namespaces", "failed"])
})

const RuleDecisionSchema = Schema.Literals(["allow", "ask", "never"])
const RuleListSchema: Schema.Codec<PermissionRuleList> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("system") }),
  Schema.Struct({ kind: Schema.Literal("space"), space_id: boundedNonEmpty(256) })
])

const PermissionRuleSubjectSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    tool: boundedNonEmpty(256),
    server: Schema.NullOr(boundedNonEmpty(256)),
    title: boundedNonEmpty(512),
    server_title: Schema.NullOr(boundedNonEmpty(512))
  }),
  Schema.Struct({
    kind: Schema.Literal("site"),
    tool: boundedNonEmpty(256),
    origin: boundedNonEmpty(512),
    title: boundedNonEmpty(512)
  }),
  Schema.Struct({
    kind: Schema.Literal("connector"),
    server: boundedNonEmpty(256),
    title: boundedNonEmpty(512)
  }),
  Schema.Struct({ kind: Schema.Literal("command"), words: boundedNonEmpty(512) }),
  Schema.Struct({ kind: Schema.Literal("host_commands") }),
  Schema.Struct({ kind: Schema.Literal("words"), text: boundedNonEmpty(2000) }),
  Schema.Struct({
    kind: Schema.Literal("path"),
    path: boundedNonEmpty(1000),
    access: Schema.Literals(["read", "change"])
  })
])

export const PermissionRuleItemSchema: Schema.Codec<PermissionRuleItem> = withExtras({
  id: PermissionIdSchema,
  list: RuleListSchema,
  decision: RuleDecisionSchema,
  from: Schema.NullOr(PermissionIdSchema),
  subject: PermissionRuleSubjectSchema
})

export const PermissionRuleListResponseSchema: Schema.Codec<PermissionRuleListResponse> =
  withExtras({ rules: Schema.Array(PermissionRuleItemSchema) })

export const NewPermissionRuleSchema: Schema.Codec<NewPermissionRule> = Schema.Struct({
  list: RuleListSchema,
  decision: RuleDecisionSchema,
  subject: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("tool"), tool: boundedNonEmpty(256) }),
    Schema.Struct({ kind: Schema.Literal("connector"), server: boundedNonEmpty(256) }),
    Schema.Struct({ kind: Schema.Literal("command"), command: boundedNonEmpty(512) }),
    Schema.Struct({ kind: Schema.Literal("host_commands") }),
    Schema.Struct({ kind: Schema.Literal("words"), text: boundedNonEmpty(2000) }),
    Schema.Struct({
      kind: Schema.Literal("path"),
      path: boundedNonEmpty(1000),
      access: Schema.Literals(["read", "change"])
    })
  ])
})

/** `PATCH /permissions/rules/:ruleId` body: the rule's new decision. */
export const PermissionRuleDecisionPatchSchema = Schema.Struct({ decision: RuleDecisionSchema })

export const encodeSpaceRulesPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(PermissionIdSchema)(value).pipe(
    Effect.map((id) => `/permissions/rules/spaces/${encodeURIComponent(id)}`)
  )

export const encodePermissionRulePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(PermissionIdSchema)(value).pipe(
    Effect.map((id) => `/permissions/rules/${encodeURIComponent(id)}`)
  )

export const ApprovalModeSchema = SpaceApprovalModeSchema

/** `GET`/`PUT /permissions/default-mode`: Settings, Permissions "When no rule
 *  fits", the mode new chats start in and every Space's task workers run in. */
export const DefaultApprovalModeSchema: Schema.Codec<DefaultApprovalMode> = Schema.Struct({
  approval_mode: ApprovalModeSchema
})

/** `PATCH /permissions/sessions/:sessionId` body: the chat's mode. */
export const SessionPermissionPatchRequestSchema = Schema.Struct({
  approval_mode: Schema.optionalKey(ApprovalModeSchema)
})
export const SessionPermissionSchema: Schema.Codec<SessionPermission> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    approval_mode: ApprovalModeSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    automation_id: Schema.String,
    tool_scope: Schema.String,
    auto_approve: Schema.Boolean,
    /** Present for a Space's task workers: the main mode (`DefaultApprovalMode`). */
    approval_mode: Schema.optionalKey(ApprovalModeSchema)
  }),
  Schema.Struct({
    kind: Schema.Literal("inherited"),
    approval_mode: Schema.optionalKey(ApprovalModeSchema)
  })
])

const CompiledSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tool"), tool: boundedNonEmpty(256) }),
  Schema.Struct({ kind: Schema.Literal("connector"), server: boundedNonEmpty(256) }),
  Schema.Struct({ kind: Schema.Literal("command"), command: boundedNonEmpty(512) }),
  Schema.Struct({
    kind: Schema.Literal("path"),
    path: boundedNonEmpty(1000),
    access: Schema.Literals(["read", "change"])
  })
])

export const CompiledRuleSchema: Schema.Codec<CompiledRule> = withExtras({
  decision: RuleDecisionSchema,
  subject: CompiledSubjectSchema
})

/** `POST /permissions/rules/compile` body: the owner's words, and the list they are for. */
export const PermissionWordsSchema = Schema.Struct({
  text: boundedNonEmpty(2000),
  list: RuleListSchema
})

export const PermissionWordsCompiledSchema: Schema.Codec<PermissionWordsCompiled> = withExtras({
  decision: RuleDecisionSchema,
  rules: Schema.Array(
    withExtras({
      decision: RuleDecisionSchema,
      subject: CompiledSubjectSchema,
      shown: PermissionRuleSubjectSchema
    })
  ),
  dropped: Schema.Array(boundedNonEmpty(500))
})

export const NewWordsRuleSchema: Schema.Codec<NewWordsRule> = withExtras({
  list: RuleListSchema,
  text: boundedNonEmpty(2000),
  decision: RuleDecisionSchema,
  rules: Schema.Array(CompiledRuleSchema).check(Schema.isMaxLength(16)),
  replaces: Schema.optionalKey(PermissionIdSchema)
})
