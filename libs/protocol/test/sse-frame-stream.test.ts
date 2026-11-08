import { describe, expect, it } from "vitest"

import { decodeSseFrameStream } from "../src/index.js"

async function* chunks(...parts: ReadonlyArray<string>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const part of parts) yield encoder.encode(part)
}

const collect = async (source: AsyncIterable<Uint8Array>) => {
  const frames = []
  for await (const frame of decodeSseFrameStream(source)) frames.push(frame)
  return frames
}

describe("decodeSseFrameStream", () => {
  it("frames events across chunks and line ends and keeps ids", async () => {
    const frames = await collect(
      chunks('id: 41\r\ndata: {"a":', "1}\r\n\r\nid: 45\ndata: one\ndata: two\n\n")
    )
    expect(frames.map((frame) => [frame.id, frame.data])).toEqual([
      ["41", '{"a":1}'],
      ["45", "one\ntwo"]
    ])
  })

  it("does not read the payload, so a stream that is not server events frames too", async () => {
    const frames = await collect(chunks("event: anything\ndata: not json\n\n"))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.data).toBe("not json")
  })
})
