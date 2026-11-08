/** Whether a child can lead its own process group (so the whole group can be signalled); Windows has none. */
export const canDetach = process.platform !== "win32"

/**
 * Signals a child's whole process group (the child and what it started). Where
 * there are no groups (Windows) or the group is gone, `fallback` signals the
 * child alone. A signal to a process that already exited is not an error.
 */
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
    } catch {
      // Already exited.
    }
  }
}

const KILL_GRACE_MS = 3_000

/**
 * SIGTERM first, so a wrapper can record how it ended (a `lab run` marks its
 * run stopped); SIGKILL once the grace passes if it still has not exited.
 */
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
