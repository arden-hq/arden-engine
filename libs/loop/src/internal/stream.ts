import { abortError } from "../abort.js"

const DEFAULT_BOUND = 256

interface Pusher {
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
}

interface Taker<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (cause: unknown) => void
}

/**
 * Bounded async push-queue with waiting-consumer handoff.
 *
 * `push()` resolves immediately while the buffer is under its bound, otherwise
 * suspends until the consumer pulls — real backpressure without making the loop
 * strictly pull-driven. `fail(error)`/`end()` terminate; `abort()` rejects both
 * waiting sides with an AbortError.
 */
export class EventQueue<T> {
  readonly #bound: number
  readonly #buffer: T[] = []
  readonly #pushers: Pusher[] = []
  readonly #takers: Taker<T>[] = []
  #terminal: { readonly done: true } | { readonly error: unknown } | null = null

  constructor(bound: number = DEFAULT_BOUND) {
    this.#bound = bound
  }

  push(item: T): Promise<void> {
    if (this.#terminal !== null) {
      return Promise.reject("error" in this.#terminal ? this.#terminal.error : abortError())
    }
    const taker = this.#takers.shift()
    if (taker !== undefined) {
      taker.resolve({ done: false, value: item })
      return Promise.resolve()
    }
    this.#buffer.push(item)
    if (this.#buffer.length <= this.#bound) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.#pushers.push({ resolve, reject })
    })
  }

  /**
   * Non-suspending push for lossy channels (tool progress): delivers to a
   * waiting consumer or buffers below the bound; returns false — dropping the
   * item — when the queue is full or terminal, so a spamming producer cannot
   * grow the buffer past its bound.
   */
  tryPush(item: T): boolean {
    if (this.#terminal !== null) return false
    const taker = this.#takers.shift()
    if (taker !== undefined) {
      taker.resolve({ done: false, value: item })
      return true
    }
    if (this.#buffer.length >= this.#bound) return false
    this.#buffer.push(item)
    return true
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#buffer.shift()
    if (item !== undefined) {
      this.#pushers.shift()?.resolve()
      return Promise.resolve({ done: false, value: item })
    }
    if (this.#terminal !== null) {
      return "error" in this.#terminal
        ? Promise.reject(this.#terminal.error)
        : Promise.resolve({ done: true, value: undefined as never })
    }
    return new Promise((resolve, reject) => {
      this.#takers.push({ resolve, reject })
    })
  }

  end(): void {
    this.#settle({ done: true })
  }

  fail(error: unknown): void {
    this.#settle({ error })
  }

  abort(): void {
    this.#settle({ error: abortError() })
  }

  #settle(terminal: { readonly done: true } | { readonly error: unknown }): void {
    if (this.#terminal !== null) return
    this.#terminal = terminal
    for (const pusher of this.#pushers.splice(0)) {
      pusher.reject("error" in terminal ? terminal.error : abortError())
    }
    if ("error" in terminal) {
      this.#buffer.length = 0
      for (const taker of this.#takers.splice(0)) taker.reject(terminal.error)
    } else if (this.#buffer.length === 0) {
      for (const taker of this.#takers.splice(0))
        taker.resolve({ done: true, value: undefined as never })
    }
  }
}
