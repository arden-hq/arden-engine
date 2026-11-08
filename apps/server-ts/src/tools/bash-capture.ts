export class BoundedCapture {
  readonly #half: number
  #head = Buffer.alloc(0)
  #tail = Buffer.alloc(0)
  #total = 0

  constructor(readonly limit: number) {
    this.#half = Math.floor(limit / 2)
  }

  append(chunk: Buffer): void {
    this.#total += chunk.byteLength
    if (this.#head.byteLength < this.#half) {
      const needed = this.#half - this.#head.byteLength
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, needed)])
    }
    this.#tail = Buffer.concat([this.#tail, chunk])
    if (this.#tail.byteLength > this.#half) {
      this.#tail = this.#tail.subarray(this.#tail.byteLength - this.#half)
    }
  }

  get totalBytes(): number {
    return this.#total
  }

  bytes(): Buffer {
    if (this.#total <= this.limit) {
      if (this.#total <= this.#head.byteLength) return this.#head
      const overlap = Math.max(0, this.#head.byteLength + this.#tail.byteLength - this.#total)
      return Buffer.concat([this.#head, this.#tail.subarray(overlap)])
    }
    return Buffer.concat([
      this.#head,
      Buffer.from(`\n\n[... ${this.#total - this.limit} bytes omitted ...]\n\n`),
      this.#tail
    ])
  }

  text(): string {
    return this.bytes().toString("utf8")
  }
}
