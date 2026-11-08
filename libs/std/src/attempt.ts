/**
 * Runs `work` now and hands back its outcome as a promise: a value or a
 * resolved promise resolves, and a throw (synchronous or not) rejects. A
 * `.catch`/`.finally` chain on it then covers what a try block around
 * `await work()` covered, a throw before the first await included.
 */
export const attempt = <T>(work: () => T | PromiseLike<T>): Promise<T> =>
  new Promise<T>((resolve) => resolve(work()))
