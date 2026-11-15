import { describe, expect, it } from "vitest"
import { coreCondenseTarget, crowdedCorePages } from "../src/memory/core-memory.js"
import { createRefusal } from "../src/wiki/mutations.js"

const profile = (chars: number) => ({ path: "me.md", pageId: "me", chars })

describe("Core Memory size", () => {
  it("asks for condensing before the profile is full", () => {
    expect(crowdedCorePages([profile(8_100)])).toEqual([])
    // The Nov 12 case: 2 characters under the budget, so every update was refused.
    expect(crowdedCorePages([profile(8_998)])).toEqual([
      { path: "me.md", chars: 8_998, budget: 9_000, target: 7_200 }
    ])
  })

  it("leaves room for later updates after one condense", () => {
    expect(crowdedCorePages([profile(coreCondenseTarget(9_000))])).toEqual([])
  })

  it("ignores pages that are not Core Memory", () => {
    expect(crowdedCorePages([{ path: "projects/arden.md", pageId: "x", chars: 30_000 }])).toEqual(
      []
    )
  })
})

describe("where a page may be created", () => {
  it("allows each standing-facts page at the root, and no other root page", () => {
    expect(createRefusal("me.md")).toBeUndefined()
    expect(createRefusal("profile.md")).toBeUndefined()
    expect(createRefusal("notes/plan.md")).toBeUndefined()
    for (const path of ["plan.md", "README.md", "notes/README.md", "health.md", "notes/plan"])
      expect(createRefusal(path)).toBeDefined()
  })
})
