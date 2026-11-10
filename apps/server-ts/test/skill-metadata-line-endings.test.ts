import { Effect } from "effect"
import { expect, it } from "vitest"
import { parseSkillMetadata } from "../src/skills/metadata.js"

it("reads a SKILL.md saved with Windows line endings", async () => {
  const source = [
    "---",
    "name: 03_task1",
    'description: "Use when: scheduling."',
    "---",
    "",
    "# Body"
  ].join("\r\n")
  const metadata = await Effect.runPromise(parseSkillMetadata(source, "03_task1", "list"))
  expect(metadata.name).toBe("03_task1")
  expect(metadata.description).toBe("Use when: scheduling.")
})
