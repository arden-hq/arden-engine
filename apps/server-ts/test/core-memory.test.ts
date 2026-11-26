import { expect, it } from "vitest"
import {
  CORE_CONDENSE_ADVICE,
  coreCondenseNotice,
  coreCondenseTarget,
  createRefusal,
  crowdedCorePages
} from "../src/memory/core-memory.js"
const profile = (chars: number) => ({ path: "me.md", pageId: "me", chars })
it("asks for condensing before the profile is full, and leaves room after one condense", () => {
  expect(crowdedCorePages([profile(8_100)])).toEqual([])
  const [page] = crowdedCorePages([profile(8_998)])
  expect(page).toBeDefined()
  if (page !== undefined) {
    expect(coreCondenseNotice(page)).toContain(CORE_CONDENSE_ADVICE)
    expect(coreCondenseNotice(page)).toContain("7200")
  }
  expect(crowdedCorePages([profile(coreCondenseTarget(9_000))])).toEqual([])
})
it("allows each standing-facts page at the root, and no other root page", () => {
  expect(createRefusal("me.md")).toBeUndefined()
  expect(createRefusal("profile.md")).toBeUndefined()
  for (const path of ["plan.md", "README.md", "health.md"])
    expect(createRefusal(path)).toBeDefined()
})
