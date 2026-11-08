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
  /** One tool; `server` is the connector it belongs to, null for one of Arden's own. */
  | {
      readonly kind: "tool"
      readonly tool: string
      readonly server: string | null
      /** The tool's own name ("Delete calendar event"). */
      readonly title: string
      /** The connector's name ("GitHub"); null for one of Arden's own tools. */
      readonly server_title: string | null
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

export interface PermissionRuleItem extends JsonRecord {
  readonly id: string
  readonly list: PermissionRuleList
  readonly decision: PermissionRuleDecision
  readonly subject: PermissionRuleSubject
  /** The words rule this hard rule was compiled from (its id); null for a
   *  rule saved on its own. The list shows it under those words. */
  readonly from: string | null
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
export const DEFAULT_APPROVAL_MODE = "safe" satisfies SessionPermission["approval_mode"]

export type SessionPermission =
  | {
      readonly kind: "chat"
      readonly approval_mode: ApprovalMode
    }
  | {
      readonly kind: "automation"
      readonly automation_id: string
      readonly tool_scope: string
      readonly auto_approve: boolean
      readonly approval_mode?: "read_only" | "ask" | "safe" | "allow"
    }
  | { readonly kind: "inherited"; readonly approval_mode?: "read_only" | "ask" | "safe" | "allow" }

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

/** `POST /permissions/rules/words`: a words rule and the hard rules the owner
 *  confirmed, saved together; `replaces` is the words rule an edit replaces. */
export interface NewWordsRule extends JsonRecord {
  readonly list: PermissionRuleList
  readonly text: string
  readonly decision: PermissionRuleDecision
  readonly rules: ReadonlyArray<CompiledRule>
  readonly replaces?: string
}
