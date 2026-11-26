const ERROR_NAME = { abort: "AbortError" } as const
type ErrorName = (typeof ERROR_NAME)[keyof typeof ERROR_NAME]

export const hasAbortName = (cause: { readonly name: string }): cause is { name: ErrorName } =>
  cause.name === ERROR_NAME.abort

export const abortError = (): Error => {
  const error = new Error("The operation was aborted")
  error.name = ERROR_NAME.abort
  return error
}

export const isAbortError = (cause: unknown): cause is Error =>
  cause instanceof Error && hasAbortName(cause)

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
