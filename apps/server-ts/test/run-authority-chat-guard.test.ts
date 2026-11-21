import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const SOURCE = join(import.meta.dirname, "../src")

const files = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const OWNERS = new Set([
  "execution/policy.ts",
  "persistence/sqlite/run-authority-chat.ts",
  "persistence/schema/decision-visibility.ts",
  "persistence/schema/decision-visibility-released.ts"
])

const GRANT_OR_WRITE =
  /(?:\b(?:resource|candidate|held|sharedOwner)\.authority_session_id|'\$\.authority_session_id'|\bauthority_session_id:)/g

it("reads a run's authority chat only through runAuthorityChat or runAuthorityChatSql", () => {
  const raw = files(SOURCE).flatMap((path) => {
    const name = relative(SOURCE, path)
    if (name.startsWith("persistence/migrations/") || OWNERS.has(name)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        line.replace(GRANT_OR_WRITE, "").includes("authority_session_id")
          ? [`${name}:${index + 1}: ${line.trim()}`]
          : []
      )
  })
  expect(raw).toEqual([])
})
