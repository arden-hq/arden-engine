import { describe, expect, it } from "vitest"
import { mintedMessageId, staleStreamedIds } from "../src/persistence/transcript/minted-ids.js"

describe("minted message ids", () => {
  it("roots a call's fragments at its turn root and derives each part from its record", () => {
    expect(mintedMessageId("a", "text", { fragment: 0, index: 0 })).toBe("a")
    expect(mintedMessageId("a", "reasoning", { fragment: 0, index: 0 })).toBe("a-reasoning")
    expect(mintedMessageId("a", "text", { fragment: 0, index: 1 })).toBe("a-text-2")
    expect(mintedMessageId("a", "text", { fragment: 2, index: 0 })).toBe("a-item-2")
    expect(mintedMessageId("a", "reasoning", { fragment: 2, index: 1 })).toBe(
      "a-item-2-reasoning-2"
    )
  })

  it("names as stale only the run's blocks whose record the transcript lacks", () => {
    const held = new Set(["a", "a-turn-1"])
    expect(
      staleStreamedIds("a", held, [
        "a",
        "a-reasoning",
        "a-text-2",
        "a-turn-1-reasoning-2",
        "a-turn-2",
        "a-turn-2-item-1",
        "a-turn-2-item-1",
        "a-turn-2-reasoning",
        "b-reasoning"
      ])
    ).toEqual(["a-turn-2", "a-turn-2-item-1", "a-turn-2-reasoning"])
  })
})
