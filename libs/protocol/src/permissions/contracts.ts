import type { JsonRecord } from "../common/json.js"
import type { AutomationToolScope } from "../automations/contracts.js"
import { APPROVAL_MODE, type ApprovalMode } from "./modes.js"

export const COMMAND_SANDBOX_STATUS = {
  notLinux: "not_linux",
  ready: "ready",
  missing: "missing",
  noNamespaces: "no_namespaces",
  failed: "failed"
} as const

export interface CommandSandboxStatus extends JsonRecord {
  readonly status: (typeof COMMAND_SANDBOX_STATUS)[keyof typeof COMMAND_SANDBOX_STATUS]
}

export const LOCKED_CATEGORIES = ["move_money", "passwords", "delete_account"] as const
export type LockedCategory = (typeof LOCKED_CATEGORIES)[number]

export const PERMISSION_RULE_DECISION = { allow: "allow", ask: "ask", never: "never" } as const

export type PermissionRuleDecision =
  (typeof PERMISSION_RULE_DECISION)[keyof typeof PERMISSION_RULE_DECISION]

export const PERMISSION_RULE_LIST = { global: "global", system: "system", space: "space" } as const

export type PermissionRuleList =
  | { readonly kind: typeof PERMISSION_RULE_LIST.global }
  | { readonly kind: typeof PERMISSION_RULE_LIST.system }
  | { readonly kind: typeof PERMISSION_RULE_LIST.space; readonly space_id: string }

export const PERMISSION_RULE_SUBJECT = {
  tool: "tool",
  site: "site",
  connector: "connector",
  command: "command",
  hostCommands: "host_commands",
  words: "words",
  path: "path",
  vaultKey: "vault_key"
} as const

export type PermissionRuleSubject =
  | {
      readonly kind: typeof PERMISSION_RULE_SUBJECT.tool
      readonly tool: string
      readonly title: string
      readonly owner: PermissionToolOwner
    }
  /** One browser tool on one site: `origin` is the site ("https://jobs.lever.co"). */
  | {
      readonly kind: typeof PERMISSION_RULE_SUBJECT.site
      readonly tool: string
      readonly origin: string
      readonly title: string
    }
  | {
      readonly kind: typeof PERMISSION_RULE_SUBJECT.connector
      readonly server: string
      readonly title: string
    }
  | { readonly kind: typeof PERMISSION_RULE_SUBJECT.command; readonly words: string }
  | { readonly kind: typeof PERMISSION_RULE_SUBJECT.hostCommands }
  | { readonly kind: typeof PERMISSION_RULE_SUBJECT.words; readonly text: string }
  | {
      readonly kind: typeof PERMISSION_RULE_SUBJECT.path
      readonly path: string
      readonly access: PermissionPathAccess
    }
  | {
      readonly kind: typeof PERMISSION_RULE_SUBJECT.vaultKey
      readonly name: string
      readonly key_id: string
    }

export const PERMISSION_TOOL_OWNER = { arden: "arden", connector: "connector" } as const

export type PermissionToolOwner =
  | { readonly kind: typeof PERMISSION_TOOL_OWNER.arden }
  | {
      readonly kind: typeof PERMISSION_TOOL_OWNER.connector
      readonly server: string
      readonly title: string
    }

export const PERMISSION_RULE_ORIGIN = { standalone: "standalone", words: "words" } as const

export type PermissionRuleOrigin =
  | { readonly kind: typeof PERMISSION_RULE_ORIGIN.standalone }
  | { readonly kind: typeof PERMISSION_RULE_ORIGIN.words; readonly rule_id: string }

export interface PermissionRuleItem extends JsonRecord {
  readonly id: string
  readonly list: PermissionRuleList
  readonly decision: PermissionRuleDecision
  readonly subject: PermissionRuleSubject
  readonly from: PermissionRuleOrigin
}

export interface PermissionRuleListResponse extends JsonRecord {
  readonly rules: ReadonlyArray<PermissionRuleItem>
}

export interface NewPermissionRule {
  readonly list: PermissionRuleList
  readonly decision: PermissionRuleDecision
  readonly subject:
    | { readonly kind: typeof PERMISSION_RULE_SUBJECT.tool; readonly tool: string }
    | { readonly kind: typeof PERMISSION_RULE_SUBJECT.connector; readonly server: string }
    | { readonly kind: typeof PERMISSION_RULE_SUBJECT.command; readonly command: string }
    | { readonly kind: typeof PERMISSION_RULE_SUBJECT.hostCommands }
    | { readonly kind: typeof PERMISSION_RULE_SUBJECT.words; readonly text: string }
    | {
        readonly kind: typeof PERMISSION_RULE_SUBJECT.path
        readonly path: string
        readonly access: PermissionPathAccess
      }
}

export const PERMISSION_PATH_ACCESS = { read: "read", change: "change" } as const

export type PermissionPathAccess =
  (typeof PERMISSION_PATH_ACCESS)[keyof typeof PERMISSION_PATH_ACCESS]

export interface DefaultApprovalMode {
  readonly approval_mode: ApprovalMode
}

export const DEFAULT_APPROVAL_MODE: ApprovalMode = APPROVAL_MODE.safe

export const SESSION_PERMISSION = {
  chat: "chat",
  automation: "automation",
  inherited: "inherited"
} as const

export type SessionPermission =
  | {
      readonly kind: typeof SESSION_PERMISSION.chat
      readonly approval_mode: ApprovalMode
    }
  | {
      readonly kind: typeof SESSION_PERMISSION.automation
      readonly automation_id: string
      readonly tool_scope: AutomationToolScope
      readonly approval: AutomationApproval
    }
  | { readonly kind: typeof SESSION_PERMISSION.inherited; readonly mode: InheritedMode }

export const sessionApprovalMode = (permission: SessionPermission): ApprovalMode | null => {
  if (permission.kind === SESSION_PERMISSION.chat) return permission.approval_mode
  if (permission.kind === SESSION_PERMISSION.automation)
    return permission.approval.kind === AUTOMATION_APPROVAL.space
      ? permission.approval.approval_mode
      : null
  return permission.mode.kind === INHERITED_MODE.set ? permission.mode.approval_mode : null
}

export const AUTOMATION_APPROVAL = { space: "space", own: "own" } as const

export type AutomationApproval =
  | { readonly kind: typeof AUTOMATION_APPROVAL.space; readonly approval_mode: ApprovalMode }
  | { readonly kind: typeof AUTOMATION_APPROVAL.own; readonly auto_approve: boolean }

export const INHERITED_MODE = { set: "set", unset: "unset" } as const

export type InheritedMode =
  | { readonly kind: typeof INHERITED_MODE.set; readonly approval_mode: ApprovalMode }
  | { readonly kind: typeof INHERITED_MODE.unset }

export interface CompiledRule extends JsonRecord {
  readonly decision: PermissionRuleDecision
  readonly subject: Exclude<
    NewPermissionRule["subject"],
    {
      readonly kind:
        | typeof PERMISSION_RULE_SUBJECT.words
        | typeof PERMISSION_RULE_SUBJECT.hostCommands
    }
  >
}

export interface PermissionWordsCompiled extends JsonRecord {
  readonly decision: PermissionRuleDecision
  readonly rules: ReadonlyArray<CompiledRule & { readonly shown: PermissionRuleSubject }>
  readonly dropped: ReadonlyArray<string>
}

export const WORDS_RULE_REPLACES = { nothing: "nothing", rule: "rule" } as const

export type WordsRuleReplaces =
  | { readonly kind: typeof WORDS_RULE_REPLACES.nothing }
  | { readonly kind: typeof WORDS_RULE_REPLACES.rule; readonly rule_id: string }

export interface NewWordsRule extends JsonRecord {
  readonly list: PermissionRuleList
  readonly text: string
  readonly decision: PermissionRuleDecision
  readonly rules: ReadonlyArray<CompiledRule>
  readonly replaces: WordsRuleReplaces
}
