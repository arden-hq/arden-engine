import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const folder = path.join(root, "docs/recipes")
const guide = readFileSync(path.join(root, "AGENTS.md"), "utf8")
const REPO_PATH = /`((?:apps|libs|tooling|docs|landing)\/[^`\s]+)`/g

const faults = readdirSync(folder)
  .filter((name) => name.endsWith(".md"))
  .flatMap((name) => {
    const text = readFileSync(path.join(folder, name), "utf8")
    const missing = [...new Set([...text.matchAll(REPO_PATH)].map((match) => match[1]))]
      .filter((named) => !existsSync(path.join(root, named)))
      .map((named) => `docs/recipes/${name} names ${named}, which does not exist`)
    return guide.includes(`docs/recipes/${name}`)
      ? missing
      : [...missing, `AGENTS.md does not list docs/recipes/${name}`]
  })

if (faults.length > 0) {
  console.error(faults.join("\n"))
  process.exit(1)
}
