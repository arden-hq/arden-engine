import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { SkillCatalog, skillCatalogLayer } from "../src/skills/service.js"

const skill = (name: string) =>
  ["---", `name: ${name}`, 'description: "Use when testing."', "---", "", "# Body"].join("\n")

const write = async (root: string, folder: string, name: string) => {
  await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, folder, "SKILL.md"), skill(name))
}

it("names a Skill in a shared folder after its SKILL.md, not its folder", async () => {
  const shared = await mkdtemp(join(tmpdir(), "skills-shared-"))
  await write(shared, "self-improving-agent-3.0.5", "self-improvement")
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const catalog = yield* SkillCatalog
      const listed = (yield* catalog.list()).filter((entry) => !entry.builtin)
      const loaded = yield* catalog.load("self-improvement")
      return { names: listed.map((entry) => entry.name), directory: loaded.directory }
    }).pipe(Effect.provide(skillCatalogLayer(null, { extraRoots: [shared] })))
  )
  expect(result.names).toEqual(["self-improvement"])
  expect(result.directory).toBe(join(shared, "self-improving-agent-3.0.5"))
})

it("still refuses a Skill in Arden's own folder whose name differs from the folder", async () => {
  const own = await mkdtemp(join(tmpdir(), "skills-own-"))
  await write(own, "folder-name", "other-name")
  const names = await Effect.runPromise(
    Effect.gen(function* () {
      const catalog = yield* SkillCatalog
      return (yield* catalog.list()).filter((entry) => !entry.builtin).map((entry) => entry.name)
    }).pipe(Effect.provide(skillCatalogLayer(own)))
  )
  expect(names).toEqual([])
})
