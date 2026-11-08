export const RUN_LIVENESS = ["turn", "background", "ended", "revoked"] as const
export type RunLiveness = (typeof RUN_LIVENESS)[number]

export const runMayAct = (liveness: RunLiveness): boolean => {
  switch (liveness) {
    case "turn":
    case "background":
      return true
    case "ended":
    case "revoked":
      return false
  }
}
