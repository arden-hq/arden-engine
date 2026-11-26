import type { ToolApprovalDecision } from "@arden-hq/loop"
import { PERMISSION_RULE_DECISION, type ApprovalMode } from "@arden-hq/protocol/permissions"
import type { PathAccess } from "../execution/rules.js"
import type { ToolFacts } from "../execution/decide.js"
import { PERMISSION_CHANGE, type OfferHolders } from "../persistence/permissions/offer.js"
import type {
  PermissionRule,
  RuleChange,
  RuleDecision,
  RuleSubject
} from "../persistence/permissions/rules.js"
import type { HostCommandGrantPlan } from "./bash-permissions.js"

interface CompiledHardRule {
  readonly subject: RuleSubject
  readonly decision: RuleDecision
}

export type OfferRequest =
  | {
      readonly kind: typeof PERMISSION_CHANGE.tool
      readonly tool: string
      readonly decision: ToolApprovalDecision
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.site
      readonly tool: string
      readonly origin: string
    }
  | { readonly kind: typeof PERMISSION_CHANGE.connector; readonly server: string }
  | { readonly kind: typeof PERMISSION_CHANGE.mode; readonly mode: ApprovalMode }
  | { readonly kind: typeof PERMISSION_CHANGE.command; readonly command: string }
  | {
      readonly kind: typeof PERMISSION_CHANGE.words
      readonly text: string
      readonly decision: RuleDecision
      readonly rules?: ReadonlyArray<CompiledHardRule>
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.path
      readonly path: string
      readonly access: PathAccess
      readonly decision:
        | typeof PERMISSION_RULE_DECISION.allow
        | typeof PERMISSION_RULE_DECISION.never
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.rule
      readonly ruleId: string
      readonly decision: RuleChange
    }

export type OfferFacts =
  | {
      readonly kind: typeof PERMISSION_CHANGE.tool
      readonly decision: ToolApprovalDecision
      readonly tool: ToolFacts
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.site
      readonly tool: ToolFacts
      readonly origin: string
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.connector
      readonly server: string
      readonly tools: number
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.mode
      readonly requested: ApprovalMode
      readonly holder:
        | {
            readonly principal: string
            readonly name: string
            readonly own: boolean
            readonly mode: ApprovalMode
          }
        | undefined
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.command
      readonly grant: HostCommandGrantPlan
      readonly system: HostCommandGrantPlan
      readonly alwaysAsk: boolean
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.words
      readonly text: string
      readonly decision: RuleDecision
      readonly rules: ReadonlyArray<CompiledHardRule>
      readonly holders: OfferHolders
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.path
      readonly path: string | undefined
      readonly access: PathAccess
      readonly decision:
        | typeof PERMISSION_RULE_DECISION.allow
        | typeof PERMISSION_RULE_DECISION.never
      readonly tooWide: boolean
      readonly holders: OfferHolders
    }
  | {
      readonly kind: typeof PERMISSION_CHANGE.rule
      readonly rule: PermissionRule | undefined
      readonly decision: RuleChange
    }

export type OfferRefusal =
  | "always_asks"
  | "your_setting"
  | "already_allowed"
  | "already_set"
  | "own_rule"
  | "own_record"
  | "does_not_ask"
  | "mode_elsewhere"
  | "no_rule"
  | "no_connector"
  | "no_tool"
  | "no_rule_id"
  | "no_words"
  | "no_path"
  | "not_compiled"
  | "too_wide"
  | "system_list"
  | "host_commands"
  | "no_holder"
  | "not_the_person"
