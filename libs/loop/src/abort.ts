export const abortError = (): Error => {
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

export const isAbortError = (cause: unknown): cause is Error =>
  cause instanceof Error && cause.name === "AbortError"

/**
 * Race a promise against an AbortSignal. Rejects with a name-based AbortError
 * as soon as the signal fires; otherwise settles with the promise. The ONE
 * shared abort helper — every consumer-facing await goes through it.
 */
export const raceAbort = <A>(promise: Promise<A>, signal?: AbortSignal): Promise<A> => {
  if (signal === undefined) return promise
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort)
        reject(cause)
      }
    )
  })
}
