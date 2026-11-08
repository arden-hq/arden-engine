export interface PendingArrivals {
  readonly notify: (runId: string) => void
  readonly wait: (runId: string, signal: AbortSignal) => Promise<void>
}

export const makePendingArrivals = (): PendingArrivals => {
  const waiters = new Map<string, Set<() => void>>()
  return {
    notify: (runId) => {
      const current = waiters.get(runId)
      if (current === undefined) return
      waiters.delete(runId)
      for (const wake of current) wake()
    },
    wait: (runId, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return
        const set = waiters.get(runId) ?? new Set<() => void>()
        const wake = (): void => {
          signal.removeEventListener("abort", forget)
          resolve()
        }
        const forget = (): void => {
          set.delete(wake)
          if (set.size === 0 && waiters.get(runId) === set) waiters.delete(runId)
        }
        set.add(wake)
        waiters.set(runId, set)
        signal.addEventListener("abort", forget, { once: true })
      })
  }
}
