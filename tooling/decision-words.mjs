import { readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const prompts = join(root, "apps/server-ts/src/prompts")
const RETIRED =
  /Never do|Do (this )?without asking|Ask first|Never touch|Use files in|without asking\?|Arden never does|Arden asks you first|Arden does these|Guidance for Auto review/u

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })

const found = walk(prompts)
  .filter((file) => file.endsWith(".md"))
  .flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        RETIRED.test(line) ? [`${relative(root, file)}:${index + 1}: ${line.trim()}`] : []
      )
  )
if (found.length > 0) {
  console.error(
    `Permission decisions read Allow / Ask / Deny (libs/protocol/src/permissions/words.ts):\n${found.join("\n")}`
  )
  process.exit(1)
}
console.log("check:decision-words: ok")
