/** Counting semaphore. `acquire()` resolves to a release function. */
export interface Semaphore {
  readonly acquire: () => Promise<() => void>
}

export const makeSemaphore = (permits: number): Semaphore => {
  let available = permits
  const waiters: Array<() => void> = []

  const release = (): void => {
    const next = waiters.shift()
    if (next !== undefined) next()
    else available += 1
  }

  const makeReleaser = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  return {
    acquire: () => {
      if (available > 0) {
        available -= 1
        return Promise.resolve(makeReleaser())
      }
      return new Promise((resolve) => {
        waiters.push(() => resolve(makeReleaser()))
      })
    }
  }
}

interface Waiter {
  readonly write: boolean
  readonly grant: () => void
  released: boolean
}

/** FIFO read/write lock. Consecutive readers share; a queued writer blocks later readers. */
export interface FairReadWriteLock {
  readonly acquire: (write: boolean) => Promise<() => void>
}

export const makeFairReadWriteLock = (): FairReadWriteLock => {
  const queue: Waiter[] = []
  let readers = 0
  let writer = false

  const grant = (waiter: Waiter): void => {
    if (waiter.write) writer = true
    else readers += 1
    waiter.grant()
  }

  const drain = (): void => {
    if (writer) return
    if (readers > 0) {
      grantQueuedReaders()
      return
    }
    const first = queue.shift()
    if (first === undefined) return
    grant(first)
    if (first.write) return
    grantQueuedReaders()
  }

  const grantQueuedReaders = (): void => {
    for (let next = queue[0]; next?.write === false; next = queue[0]) {
      queue.shift()
      grant(next)
    }
  }

  const release = (waiter: Waiter): void => {
    if (waiter.released) return
    waiter.released = true
    if (waiter.write) writer = false
    else readers -= 1
    drain()
  }

  return {
    acquire: (write) =>
      new Promise((resolve) => {
        const waiter: Waiter = {
          write,
          grant: () => resolve(() => release(waiter)),
          released: false
        }
        queue.push(waiter)
        drain()
      })
  }
}
