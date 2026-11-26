import type { LockedCategory } from "@arden-hq/protocol/permissions"
import { TOOL_ACTION } from "@arden-hq/protocol/tools"
import { OUTWARD_CATEGORY, type OutwardCategory } from "./review.js"
import type { ToolFacts } from "./decide.js"

export const CALL_IMPACT = {
  inert: "inert",
  contained: "contained",
  outward: "outward",
  locked: "locked"
} as const

export type CallImpact =
  | { readonly kind: typeof CALL_IMPACT.inert }
  | { readonly kind: typeof CALL_IMPACT.contained }
  | { readonly kind: typeof CALL_IMPACT.outward; readonly category: OutwardCategory }
  | { readonly kind: typeof CALL_IMPACT.locked; readonly category: LockedCategory }

export const INERT: CallImpact = { kind: CALL_IMPACT.inert }
export const CONTAINED: CallImpact = { kind: CALL_IMPACT.contained }
export const OUTWARD: CallImpact = { kind: CALL_IMPACT.outward, category: OUTWARD_CATEGORY.unknown }

export const readsOnly = (tool: Pick<ToolFacts, "action" | "changes_state">): boolean =>
  tool.action === TOOL_ACTION.read && !tool.changes_state

export const defaultImpact = (
  tool: Pick<ToolFacts, "action" | "changes_state" | "per_call">
): CallImpact => {
  if (readsOnly(tool)) return INERT
  return tool.per_call ? CONTAINED : OUTWARD
}
