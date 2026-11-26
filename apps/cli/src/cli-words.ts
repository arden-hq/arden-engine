export const CLI_OUTPUT_FORMAT = { text: "text", json: "json", jsonl: "jsonl" } as const

export type CliOutputFormat = (typeof CLI_OUTPUT_FORMAT)[keyof typeof CLI_OUTPUT_FORMAT]

export const APPROVAL_HANDLING = {
  wait: "wait",
  decline: "decline",
  askThenDecline: "ask_then_decline"
} as const

export type ApprovalHandling = (typeof APPROVAL_HANDLING)[keyof typeof APPROVAL_HANDLING]

export const SESSION_TARGET = {
  new: "new",
  existing: "existing",
  latest: "latest",
  fork: "fork"
} as const

export const RECEIPT_STATUS = {
  completed: "completed",
  submitted: "submitted",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  timedOut: "timed_out"
} as const

export type ReceiptStatus = (typeof RECEIPT_STATUS)[keyof typeof RECEIPT_STATUS]

export const STDIN_KIND = {
  terminal: "terminal",
  pipe: "pipe",
  file: "file",
  other: "other"
} as const

export type StdinKind = (typeof STDIN_KIND)[keyof typeof STDIN_KIND]

export const APP_KIND = { background: "background", tooOld: "too_old" } as const

export const FOUND_SERVER = { found: "found", none: "none", tooOld: "too_old" } as const

export const LOGIN_ACTION = { signIn: "sign_in", status: "status", signOut: "sign_out" } as const

export type LoginAction = (typeof LOGIN_ACTION)[keyof typeof LOGIN_ACTION]

export const SERVER_EXIT = { stopped: "stopped" } as const

export const SERVER_FAILURE = {
  settings: "settings",
  provider: "provider",
  start: "start"
} as const

export const BOOLEAN_PLIST = { one: "1", true: "true" } as const

export const MEDIA_EXTENSION = { png: ".png", jpg: ".jpg", jpeg: ".jpeg" } as const

const PROCESS_ERRNO = { eperm: "EPERM" } as const

type ProcessErrno = (typeof PROCESS_ERRNO)[keyof typeof PROCESS_ERRNO]

export type MediaExtension = (typeof MEDIA_EXTENSION)[keyof typeof MEDIA_EXTENSION]

export const isMediaExtension = (value: string): value is MediaExtension =>
  value === MEDIA_EXTENSION.png || value === MEDIA_EXTENSION.jpg || value === MEDIA_EXTENSION.jpeg

export type ServerFailure = (typeof SERVER_FAILURE)[keyof typeof SERVER_FAILURE]

export const isPermissionDenied = (
  cause: unknown,
  code: ProcessErrno = PROCESS_ERRNO.eperm
): boolean => cause instanceof Error && "code" in cause && cause.code === code
