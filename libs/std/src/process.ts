export const PLATFORM = {
  darwin: "darwin",
  linux: "linux",
  windows: "win32"
} as const satisfies Record<string, NodeJS.Platform>
export type Platform = (typeof PLATFORM)[keyof typeof PLATFORM]

export const onWindows = process.platform === PLATFORM.windows

export const canDetach = !onWindows

export const signalProcessGroup = (
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback?: (signal: NodeJS.Signals) => void
): void => {
  if (pid === undefined) return
  try {
    if (!canDetach) fallback?.(signal)
    else process.kill(-pid, signal)
  } catch {
    try {
      fallback?.(signal)
    } catch {}
  }
}

const KILL_GRACE_MS = 3_000

export const terminate = (
  send: (signal: NodeJS.Signals) => void,
  ended: () => boolean,
  graceMs: number = KILL_GRACE_MS
): void => {
  if (ended()) return
  send("SIGTERM")
  setTimeout(() => {
    if (!ended()) send("SIGKILL")
  }, graceMs).unref()
}
