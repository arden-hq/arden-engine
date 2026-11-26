export const PROVIDER_COST = { unreported: "unreported", reported: "reported" } as const

export const LOCAL_INSTRUCTION_STATUS = {
  loaded: "loaded",
  truncated: "truncated",
  empty: "empty",
  unreadable: "unreadable"
} as const

export const RUN_STOP_REASON = { unstated: "unstated", stated: "stated" } as const

export const RUN_RESULT = { none: "none", on_time: "on_time", late: "late" } as const

export const RUN_FAILURE = { none: "none", failed: "failed" } as const

export const RUN_EVENTS_SEEN = { none: "none", through: "through" } as const

export const RUN_MODEL = { unrecorded: "unrecorded", model: "model" } as const

export const RUN_REASONING = { default: "default", effort: "effort" } as const

export const RUN_CLIENT = { none: "none", client: "client" } as const

export const RUN_TRACE = { kept: "kept", removed: "removed" } as const

export const PLAN_LIMIT_REACHED = { not_before_reset: "not_before_reset", at: "at" } as const

export const PLAN_CREDITS = {
  unreported: "unreported",
  unlimited: "unlimited",
  limited: "limited"
} as const

export const CREDIT_BALANCE = { unreported: "unreported", reported: "reported" } as const

export const PLAN_NAME = { unnamed: "unnamed", named: "named" } as const
