/**
 * Wait `ms`. An aborted `signal` ends the wait at once by rejecting with
 * `signal.reason`; a signal already aborted rejects without arming a timer. The
 * timer and the listener are gone on every path.
 */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
