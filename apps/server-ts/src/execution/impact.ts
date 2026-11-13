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

/** The one test for "this call only reads": scopes, approvals and impact all use it. */
export const readsOnly = (tool: Pick<ToolFacts, "action" | "changes_state">): boolean =>
  tool.action === "read" && !tool.changes_state

export const defaultImpact = (
  tool: Pick<ToolFacts, "action" | "changes_state" | "per_call">
): CallImpact => {
  if (readsOnly(tool)) return INERT
  return tool.per_call ? CONTAINED : OUTWARD
}
