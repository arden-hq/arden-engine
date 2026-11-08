export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<A>(key: string, operation: () => Promise<A>): Promise<A> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
