const FRAME_BYTES = 8 * 1024

const FLUSH_INTERVAL_MS = 50

const EMPTY = Buffer.alloc(0)

type ToolOutputStreamName = "stdout" | "stderr"

export interface ToolOutputFrame {
  readonly stream: ToolOutputStreamName
  readonly delta: string
}

export interface ToolOutputStream {
  readonly write: (stream: ToolOutputStreamName, chunk: Buffer) => void
  readonly close: () => Promise<void>
}

/**
 * Longest prefix of `buffer` no longer than `limit` that ends on a complete
 * UTF-8 code point. A split sequence would decode to U+FFFD on both sides of
 * the frame boundary, so the trailing bytes wait for the rest of the sequence.
 */
const sequenceWidth = (lead: number): number => {
  if (lead < 0x80) return 1
  if (lead < 0xe0) return 2
  if (lead < 0xf0) return 3
  return 4
}

const utf8FrameLength = (buffer: Buffer, limit: number): number => {
  const end = Math.min(buffer.byteLength, limit)
  if (end === 0) return 0
  const floor = Math.max(0, end - 4)
  let lead = end - 1
  while (lead > floor && (buffer.readUInt8(lead) & 0xc0) === 0x80) lead -= 1
  return lead + sequenceWidth(buffer.readUInt8(lead)) <= end ? end : lead
}

export const makeToolOutputStream = (
  emit: (frame: ToolOutputFrame) => Promise<void>,
  quotaBytes: number
): ToolOutputStream => {
  const pending = new Map<ToolOutputStreamName, Buffer>()
  let budget = quotaBytes
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled: Promise<void> = Promise.resolve()

  const drain = (final: boolean): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    for (const [stream, buffered] of pending) {
      let rest = buffered
      while (budget > 0 && rest.byteLength > 0) {
        const limit = Math.min(FRAME_BYTES, budget)
        const length =
          final && rest.byteLength <= limit ? rest.byteLength : utf8FrameLength(rest, limit)
        if (length === 0) break
        const delta = rest.subarray(0, length).toString("utf8")
        settled = settled.then(() => emit({ stream, delta })).catch(() => undefined)
        budget -= length
        rest = rest.subarray(length)
      }
      pending.set(stream, budget > 0 ? rest : EMPTY)
    }
  }

  return {
    write: (stream, chunk) => {
      if (closed || budget <= 0) return
      const buffered = Buffer.concat([pending.get(stream) ?? EMPTY, chunk])
      pending.set(stream, buffered)
      if (buffered.byteLength >= FRAME_BYTES) drain(false)
      else if (timer === undefined) timer = setTimeout(() => drain(false), FLUSH_INTERVAL_MS)
    },
    close: () => {
      drain(true)
      closed = true
      return settled
    }
  }
}
