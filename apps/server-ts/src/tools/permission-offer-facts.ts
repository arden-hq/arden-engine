import type { ToolApprovalDecision } from "@arden-hq/loop"
import { type PathAccess } from "../execution/rules.js"
import { type ToolFacts } from "../execution/decide.js"
import { type ApprovalMode } from "@arden-hq/protocol/permissions"
import { type OfferHolders } from "../persistence/permissions/offer.js"
import type { RuleChange } from "../persistence/permissions/rules.js"
import {
  type PermissionRule,
  type RuleDecision,
  type RuleSubject
} from "../persistence/permissions/rules.js"
import type { HostCommandGrantPlan } from "./bash-permissions.js"

export type OfferRequest =
  | { readonly kind: "tool"; readonly tool: string; readonly decision: ToolApprovalDecision }
  | { readonly kind: "site"; readonly tool: string; readonly origin: string }
  | { readonly kind: "connector"; readonly server: string }
  | { readonly kind: "mode"; readonly mode: ApprovalMode }
  | { readonly kind: "command"; readonly command: string }
  | {
      readonly kind: "words"
      readonly text: string
      readonly decision: RuleDecision
      readonly rules?: ReadonlyArray<CompiledHardRule>
    }
  | {
      readonly kind: "path"
      readonly path: string
      readonly access: PathAccess
      readonly decision: "allow" | "never"
    }
  | { readonly kind: "rule"; readonly ruleId: string; readonly decision: RuleChange }

export type OfferFacts =
  | {
      readonly kind: "tool"
      readonly decision: ToolApprovalDecision
      readonly tool: ToolFacts
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "site"
      readonly tool: ToolFacts
      readonly origin: string
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "connector"
      readonly server: string
      readonly tools: number
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "mode"
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
      readonly kind: "command"
      readonly grant: HostCommandGrantPlan
      readonly system: HostCommandGrantPlan
      readonly alwaysAsk: boolean
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "words"
      readonly text: string
      readonly decision: RuleDecision
      readonly rules: ReadonlyArray<CompiledHardRule>
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "path"
      readonly path: string | undefined
      readonly access: PathAccess
      readonly decision: "allow" | "never"
      readonly tooWide: boolean
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "rule"
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

interface CompiledHardRule {
  readonly subject: RuleSubject
  readonly decision: RuleDecision
}
