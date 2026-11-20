/** How much a run may do without asking, least to most permissive. */
export const APPROVAL_MODES = ["read_only", "ask", "safe", "allow"] as const

export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  APPROVAL_MODES.some((mode) => mode === value)

/** The less permissive of two modes; continuation and delegation may only narrow. */
export const narrowerApprovalMode = (left: ApprovalMode, right: ApprovalMode): ApprovalMode =>
  APPROVAL_MODES.indexOf(left) <= APPROVAL_MODES.indexOf(right) ? left : right

export const commandLineApprovalMode = (requested: ApprovalMode | undefined): ApprovalMode =>
  requested ?? "safe"
