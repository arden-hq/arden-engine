import { Schema } from "effect"
import { expect, it } from "vitest"
import { skillMentions } from "../src/skills/index.js"
import { SkillNameSchema } from "../src/skills/schema.js"

const valid = Schema.is(SkillNameSchema)

it("accepts the names other harnesses' Skills use", () => {
  for (const name of ["agent-browser", "03_task1", "2fa", "_private", "a".repeat(64)])
    expect(valid(name), name).toBe(true)
})

it("refuses a name that is not a safe folder name or URL segment", () => {
  for (const name of ["", "-lead", "Upper", "a.b", "a/b", "a b", "..", "a".repeat(65)])
    expect(valid(name), name).toBe(false)
})

it("finds a slash mention under the same spelling", () => {
  expect(skillMentions("use /03_task1 and /agent-browser now").map((m) => m.name)).toEqual([
    "03_task1",
    "agent-browser"
  ])
  expect(skillMentions("a/b and /usr/bin and 1/2").length).toBe(0)
})
