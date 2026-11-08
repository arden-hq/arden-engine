import type { LockedCategory } from "@arden-hq/protocol/permissions"
import type { ReviewPolicyCategory } from "./review.js"
import type { ToolFacts } from "./decide.js"

export type CallImpact =
  | { readonly kind: "inert" }
  | { readonly kind: "contained" }
  | { readonly kind: "outward"; readonly category: OutwardCategory }
  | { readonly kind: "locked"; readonly category: LockedCategory }

export type OutwardCategory = Exclude<ReviewPolicyCategory, "none"> | "unknown"

export const INERT: CallImpact = { kind: "inert" }
export const CONTAINED: CallImpact = { kind: "contained" }
export const OUTWARD: CallImpact = { kind: "outward", category: "unknown" }

export const defaultImpact = (
  tool: Pick<ToolFacts, "action" | "changes_state" | "per_call">
): CallImpact => {
  if (tool.action === "read" && !tool.changes_state) return INERT
  return tool.per_call ? CONTAINED : OUTWARD
}
