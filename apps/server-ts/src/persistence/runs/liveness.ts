export const RUN_LIVENESS = {
  turn: "turn",
  background: "background",
  ended: "ended",
  revoked: "revoked"
} as const

export type RunLiveness = (typeof RUN_LIVENESS)[keyof typeof RUN_LIVENESS]

export const runMayAct = (liveness: RunLiveness): boolean => {
  switch (liveness) {
    case RUN_LIVENESS.turn:
    case RUN_LIVENESS.background:
      return true
    case RUN_LIVENESS.ended:
    case RUN_LIVENESS.revoked:
      return false
  }
}
