export const APPROVAL_MODE = {
  readOnly: "read_only",
  ask: "ask",
  safe: "safe",
  allow: "allow"
} as const

export type ApprovalMode = (typeof APPROVAL_MODE)[keyof typeof APPROVAL_MODE]

export const APPROVAL_MODES: ReadonlyArray<ApprovalMode> = Object.values(APPROVAL_MODE)

export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  APPROVAL_MODES.some((mode) => mode === value)

export const narrowerApprovalMode = (left: ApprovalMode, right: ApprovalMode): ApprovalMode =>
  APPROVAL_MODES.indexOf(left) <= APPROVAL_MODES.indexOf(right) ? left : right

export const commandLineApprovalMode = (requested: ApprovalMode | undefined): ApprovalMode =>
  requested ?? APPROVAL_MODE.safe
