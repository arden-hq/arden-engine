import { Effect } from "effect"
import { expect, it } from "vitest"
import { parseSkillMetadata } from "../src/skills/metadata.js"

const parse = (...frontmatter: ReadonlyArray<string>) =>
  Effect.runPromise(
    parseSkillMetadata(["---", ...frontmatter, "---", "", "# Body"].join("\n"), null, "list")
  )

it("loads a Skill whose optional fields are not Arden's shape, keeping what it can", async () => {
  expect(
    await parse(
      "name: aws-cdk",
      "description: Builds CDK apps.",
      "version: 2",
      "tool_group: ''",
      "user_invocable: yes-please",
      "disable-model-invocation: true"
    )
  ).toEqual({
    name: "aws-cdk",
    description: "Builds CDK apps.",
    version: "2.0.0",
    "disable-model-invocation": true
  })
  expect(await parse("name: a", "description: b", "version: v1.2")).toEqual({
    name: "a",
    description: "b",
    version: "1.2.0"
  })
  expect(await parse("name: a", "description: b", "version: latest")).toEqual({
    name: "a",
    description: "b"
  })
})

it("names the field when a Skill cannot load", async () => {
  await expect(parse("name: a")).rejects.toMatchObject({
    message: "Skill metadata `description` is missing or invalid"
  })
})
