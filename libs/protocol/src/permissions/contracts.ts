import type { JsonRecord } from "../common/json.js"
import type { ApprovalMode } from "./modes.js"

/** Whether this computer can confine the commands Arden runs. Linux confines
 *  them with bubblewrap: "missing" when it isn't installed, "no_namespaces"
 *  when the kernel refuses it user namespaces, "failed" when it can't start
 *  for another reason. Other systems answer "not_linux". */
export interface CommandSandboxStatus extends JsonRecord {
  readonly status: "not_linux" | "ready" | "missing" | "no_namespaces" | "failed"
}

/**
 * The locked list (moving money, using a password, deleting an account): a
 * call a tool places in one of these asks the owner, above every rule and
 * mode, and no rule unlocks it. Settings shows one locked row per category.
 */
export const LOCKED_CATEGORIES = ["move_money", "passwords", "delete_account"] as const
export type LockedCategory = (typeof LOCKED_CATEGORIES)[number]

/** What one rule decides. */
export type PermissionRuleDecision = "allow" | "ask" | "never"

/** Which list a rule sits in: the global list, Arden's own jobs' list
 *  (Settings, Permissions shows both) or one Space's list (its setup page). */
export type PermissionRuleList =
  | { readonly kind: "global" }
  | { readonly kind: "system" }
  | { readonly kind: "space"; readonly space_id: string }

/** What a rule is about, with the names the owner knows its parts by. */
export type PermissionRuleSubject =
  | {
      readonly kind: "tool"
      readonly tool: string
      readonly title: string
      readonly owner: PermissionToolOwner
    }
  /** One browser tool on one site: `origin` is the site ("https://jobs.lever.co"). */
  | {
      readonly kind: "site"
      readonly tool: string
      readonly origin: string
      /** The tool's own name ("Upload file"). */
      readonly title: string
    }
  /** Every tool of one connector. */
  | { readonly kind: "connector"; readonly server: string; readonly title: string }
  /** Host commands that start with these words: the executable's name, then its arguments. */
  | { readonly kind: "command"; readonly words: string }
  /** Every command on the owner's Mac asks: only ever "ask". */
  | { readonly kind: "host_commands" }
  /** The owner's own words, read by the Auto reviewer. */
  | { readonly kind: "words"; readonly text: string }
  /** Files in one folder: `read` is using them, `change` is writing them. */
  | { readonly kind: "path"; readonly path: string; readonly access: PermissionPathAccess }
  /** One saved key, by its Vault name ("Todoist"): the agent may use it without asking. */
  | { readonly kind: "vault_key"; readonly name: string; readonly key_id: string }

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

/** The rules one page shows, newest first: Settings' global and system
 *  lists, or one Space's list. A write answers with the page the rule is on. */
export interface PermissionRuleListResponse extends JsonRecord {
  readonly rules: ReadonlyArray<PermissionRuleItem>
}

/** `POST /permissions/rules`: a new rule, or the same subject's rule replaced.
 *  A command is the words the owner typed ("gh pr view"); the server keeps
 *  the prefix it would save from a card. */
export interface NewPermissionRule {
  readonly list: PermissionRuleList
  readonly decision: PermissionRuleDecision
  readonly subject:
    | { readonly kind: "tool"; readonly tool: string }
    | { readonly kind: "connector"; readonly server: string }
    | { readonly kind: "command"; readonly command: string }
    | { readonly kind: "host_commands" }
    | { readonly kind: "words"; readonly text: string }
    /** A folder as the owner picked or typed it; the server keeps it canonical. */
    | { readonly kind: "path"; readonly path: string; readonly access: PermissionPathAccess }
}

/** What a path rule governs: using a folder's files, or changing them. */
export type PermissionPathAccess = "read" | "change"

/** Settings, Permissions "When no rule fits": the mode a new chat starts in
 *  and every Space's task workers run in. The server holds it. */
export interface DefaultApprovalMode {
  readonly approval_mode: ApprovalMode
}

/** The mode a Chat or Automation runs under until someone picks another: Auto,
 *  where the Helper review (Guardian) approves routine calls and asks when unsure. */
export const DEFAULT_APPROVAL_MODE = "safe" satisfies ApprovalMode

export type SessionPermission =
  | {
      readonly kind: "chat"
      readonly approval_mode: ApprovalMode
    }
  | {
      readonly kind: "automation"
      readonly automation_id: string
      readonly tool_scope: string
      readonly approval: AutomationApproval
    }
  | { readonly kind: "inherited"; readonly mode: InheritedMode }

export const sessionApprovalMode = (permission: SessionPermission): ApprovalMode | null => {
  if (permission.kind === SESSION_PERMISSION.chat) return permission.approval_mode
  if (permission.kind === SESSION_PERMISSION.automation)
    return permission.approval.kind === AUTOMATION_APPROVAL.space
      ? permission.approval.approval_mode
      : null
  return permission.mode.kind === INHERITED_MODE.set ? permission.mode.approval_mode : null
}

export const SESSION_PERMISSION = {
  chat: "chat",
  automation: "automation",
  inherited: "inherited"
} as const

export const AUTOMATION_APPROVAL = { space: "space", own: "own" } as const

export type AutomationApproval =
  | { readonly kind: typeof AUTOMATION_APPROVAL.space; readonly approval_mode: ApprovalMode }
  | { readonly kind: typeof AUTOMATION_APPROVAL.own; readonly auto_approve: boolean }

export const INHERITED_MODE = { set: "set", unset: "unset" } as const

export type InheritedMode =
  | { readonly kind: typeof INHERITED_MODE.set; readonly approval_mode: ApprovalMode }
  | { readonly kind: typeof INHERITED_MODE.unset }

/** One hard rule a words rule compiles to, as the owner confirms it. */
export interface CompiledRule extends JsonRecord {
  readonly decision: PermissionRuleDecision
  readonly subject: Exclude<
    NewPermissionRule["subject"],
    { readonly kind: "words" | "host_commands" }
  >
}

/** `POST /permissions/rules/compile`: what the owner's words mean as hard
 *  rules, read by a model once, at save time, for the owner to check before
 *  saving. `shown` is each rule as its list row names it; `dropped` names
 *  what the model read that no hard rule can hold. No rules: the words stay
 *  guidance for the Auto reviewer, not a lock. */
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
