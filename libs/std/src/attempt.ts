export const attempt = <T>(work: () => T | PromiseLike<T>): Promise<T> =>
  new Promise<T>((resolve) => resolve(work()))

export const SETTLED = {
  fulfilled: "fulfilled",
  rejected: "rejected"
} as const satisfies { readonly [Status in PromiseSettledResult<unknown>["status"]]: Status }

export type SettledStatus = (typeof SETTLED)[keyof typeof SETTLED]

export const isFulfilled = <T>(
  result: PromiseSettledResult<T>
): result is PromiseFulfilledResult<T> => result.status === SETTLED.fulfilled

export const isRejected = <T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult =>
  result.status === SETTLED.rejected
