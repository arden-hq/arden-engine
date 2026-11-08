/** How much a run may do without asking, least to most permissive. */
export const APPROVAL_MODES = ["read_only", "ask", "safe", "allow"] as const

export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  APPROVAL_MODES.some((mode) => mode === value)

/** The less permissive of two modes; continuation and delegation may only narrow. */
export const narrowerApprovalMode = (left: ApprovalMode, right: ApprovalMode): ApprovalMode =>
  APPROVAL_MODES.indexOf(left) <= APPROVAL_MODES.indexOf(right) ? left : right

/** The modes a command-line caller may ask for: Auto and Never ask are set in the app. */
export const CLI_APPROVAL_MODES = [
  "read_only",
  "ask"
] as const satisfies ReadonlyArray<ApprovalMode>

export type CliApprovalMode = (typeof CLI_APPROVAL_MODES)[number]

export const isCliApprovalMode = (value: unknown): value is CliApprovalMode =>
  CLI_APPROVAL_MODES.some((mode) => mode === value)

export const CLI_DEFAULT_APPROVAL_MODE = "ask" satisfies CliApprovalMode
