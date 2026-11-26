import { nonRelativePathSegment } from "../common/routes.js"
import { SpaceApprovalModeSchema } from "../spaces/schema.js"
import { Effect, Schema } from "effect"
import { AutomationToolScopeSchema } from "../automations/schema.js"
import {
  AUTOMATION_APPROVAL,
  COMMAND_SANDBOX_STATUS,
  INHERITED_MODE,
  PERMISSION_PATH_ACCESS,
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_ORIGIN,
  PERMISSION_RULE_SUBJECT,
  PERMISSION_TOOL_OWNER,
  SESSION_PERMISSION,
  WORDS_RULE_REPLACES,
  type CommandSandboxStatus,
  type NewPermissionRule,
  type PermissionRuleItem,
  type PermissionRuleListResponse,
  type PermissionWordsCompiled,
  type NewWordsRule,
  type CompiledRule,
  type PermissionRuleList,
  type SessionPermission,
  type DefaultApprovalMode
} from "./contracts.js"
import { withExtras } from "../common/schema.js"

const boundedNonEmpty = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))
export const PermissionIdSchema = boundedNonEmpty(128).check(nonRelativePathSegment)

export const CommandSandboxStatusSchema: Schema.Codec<CommandSandboxStatus> = withExtras({
  status: Schema.Literals(Object.values(COMMAND_SANDBOX_STATUS))
})

const RuleDecisionSchema = Schema.Literals(Object.values(PERMISSION_RULE_DECISION))
const RuleListSchema: Schema.Codec<PermissionRuleList> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_LIST.global) }),
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_LIST.system) }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_LIST.space),
    space_id: boundedNonEmpty(256)
  })
])

const PermissionRuleSubjectSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.tool),
    tool: boundedNonEmpty(256),
    title: boundedNonEmpty(512),
    owner: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(PERMISSION_TOOL_OWNER.arden) }),
      Schema.Struct({
        kind: Schema.Literal(PERMISSION_TOOL_OWNER.connector),
        server: boundedNonEmpty(256),
        title: boundedNonEmpty(512)
      })
    ])
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.site),
    tool: boundedNonEmpty(256),
    origin: boundedNonEmpty(512),
    title: boundedNonEmpty(512)
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.connector),
    server: boundedNonEmpty(256),
    title: boundedNonEmpty(512)
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.command),
    words: boundedNonEmpty(512)
  }),
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_SUBJECT.hostCommands) }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.words),
    text: boundedNonEmpty(2000)
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.path),
    path: boundedNonEmpty(1000),
    access: Schema.Literals(Object.values(PERMISSION_PATH_ACCESS))
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.vaultKey),
    name: boundedNonEmpty(64),
    key_id: boundedNonEmpty(64)
  })
])

export const PermissionRuleItemSchema: Schema.Codec<PermissionRuleItem> = withExtras({
  id: PermissionIdSchema,
  list: RuleListSchema,
  decision: RuleDecisionSchema,
  from: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_ORIGIN.standalone) }),
    Schema.Struct({
      kind: Schema.Literal(PERMISSION_RULE_ORIGIN.words),
      rule_id: PermissionIdSchema
    })
  ]),
  subject: PermissionRuleSubjectSchema
})

export const PermissionRuleListResponseSchema: Schema.Codec<PermissionRuleListResponse> =
  withExtras({ rules: Schema.Array(PermissionRuleItemSchema) })

export const NewPermissionRuleSchema: Schema.Codec<NewPermissionRule> = Schema.Struct({
  list: RuleListSchema,
  decision: RuleDecisionSchema,
  subject: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal(PERMISSION_RULE_SUBJECT.tool),
      tool: boundedNonEmpty(256)
    }),
    Schema.Struct({
      kind: Schema.Literal(PERMISSION_RULE_SUBJECT.connector),
      server: boundedNonEmpty(256)
    }),
    Schema.Struct({
      kind: Schema.Literal(PERMISSION_RULE_SUBJECT.command),
      command: boundedNonEmpty(512)
    }),
    Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_SUBJECT.hostCommands) }),
    Schema.Struct({
      kind: Schema.Literal(PERMISSION_RULE_SUBJECT.words),
      text: boundedNonEmpty(2000)
    }),
    Schema.Struct({
      kind: Schema.Literal(PERMISSION_RULE_SUBJECT.path),
      path: boundedNonEmpty(1000),
      access: Schema.Literals(Object.values(PERMISSION_PATH_ACCESS))
    })
  ])
})

export const PermissionRuleDecisionPatchSchema = Schema.Struct({ decision: RuleDecisionSchema })

export const encodeSpaceRulesPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(PermissionIdSchema)(value).pipe(
    Effect.map((id) => `/permissions/rules/spaces/${encodeURIComponent(id)}`)
  )

export const encodePermissionRulePathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(PermissionIdSchema)(value).pipe(
    Effect.map((id) => `/permissions/rules/${encodeURIComponent(id)}`)
  )

export const ApprovalModeSchema = SpaceApprovalModeSchema

export const DefaultApprovalModeSchema: Schema.Codec<DefaultApprovalMode> = Schema.Struct({
  approval_mode: ApprovalModeSchema
})

export const SessionPermissionPatchRequestSchema = Schema.Struct({
  approval_mode: ApprovalModeSchema
})
export const SessionPermissionSchema: Schema.Codec<SessionPermission> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(SESSION_PERMISSION.chat),
    approval_mode: ApprovalModeSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(SESSION_PERMISSION.automation),
    automation_id: Schema.String,
    tool_scope: AutomationToolScopeSchema,
    approval: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal(AUTOMATION_APPROVAL.space),
        approval_mode: ApprovalModeSchema
      }),
      Schema.Struct({ kind: Schema.Literal(AUTOMATION_APPROVAL.own), auto_approve: Schema.Boolean })
    ])
  }),
  Schema.Struct({
    kind: Schema.Literal(SESSION_PERMISSION.inherited),
    mode: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal(INHERITED_MODE.set),
        approval_mode: ApprovalModeSchema
      }),
      Schema.Struct({ kind: Schema.Literal(INHERITED_MODE.unset) })
    ])
  })
])

const CompiledSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(PERMISSION_RULE_SUBJECT.tool), tool: boundedNonEmpty(256) }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.connector),
    server: boundedNonEmpty(256)
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.command),
    command: boundedNonEmpty(512)
  }),
  Schema.Struct({
    kind: Schema.Literal(PERMISSION_RULE_SUBJECT.path),
    path: boundedNonEmpty(1000),
    access: Schema.Literals(Object.values(PERMISSION_PATH_ACCESS))
  })
])

export const CompiledRuleSchema: Schema.Codec<CompiledRule> = withExtras({
  decision: RuleDecisionSchema,
  subject: CompiledSubjectSchema
})

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
  replaces: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WORDS_RULE_REPLACES.nothing) }),
    Schema.Struct({ kind: Schema.Literal(WORDS_RULE_REPLACES.rule), rule_id: PermissionIdSchema })
  ])
})
