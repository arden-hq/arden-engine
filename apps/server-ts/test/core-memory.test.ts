import { expect, it } from "vitest"
import { coreCondenseTarget, crowdedCorePages } from "../src/memory/core-memory.js"
import { createRefusal } from "../src/wiki/write-rules.js"
const profile = (chars: number) => ({ path: "me.md", pageId: "me", chars })
it("asks for condensing before the profile is full, and leaves room after one condense", () => {
  expect(crowdedCorePages([profile(8_100)])).toEqual([])
  expect(crowdedCorePages([profile(8_998)])).toHaveLength(1)
  expect(crowdedCorePages([profile(coreCondenseTarget(9_000))])).toEqual([])
})
it("allows each standing-facts page at the root, and no other root page", () => {
  expect(createRefusal("me.md")).toBeUndefined()
  expect(createRefusal("profile.md")).toBeUndefined()
  for (const path of ["plan.md", "README.md", "health.md"])
    expect(createRefusal(path)).toBeDefined()
})
