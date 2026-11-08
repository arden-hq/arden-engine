import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { normalizeRelativePath } from "../src/domain/model.js"

describe("managed paths", () => {
  it("accepts canonical paths and rejects unsafe paths", () => {
    for (const path of ["note.md", "notes/one.md", "é/😀.md"]) {
      expect(Effect.runSync(normalizeRelativePath(path)), path).toBe(path)
    }

    for (const path of [
      "",
      "/absolute",
      "../escape",
      "a/../b",
      "a/./b",
      "a//b",
      "a/",
      "a\\b",
      "C:/escape",
      "bad\u0000name"
    ]) {
      expect(() => Effect.runSync(normalizeRelativePath(path)), path).toThrow()
    }
  })
})
