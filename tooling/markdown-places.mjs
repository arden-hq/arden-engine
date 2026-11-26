import { execFileSync } from "node:child_process"
import { matchesGlob, resolve } from "node:path"

const places = ["**/README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "docs/**", "apps/server-ts/docs/**", ".claude/skills/**", "apps/server-ts/src/prompts/authored/**", "apps/server-ts/src/browser/procedures/POMERADO-LICENSE.md"]

const root = resolve(import.meta.dirname, "..")
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
})
  .split("\0")
  .filter((file) => /\.(md|mdx|markdown|mdown|mdwn|mkd|mkdn|mkdown|mdtxt|mdtext|ronn|scd|workbook)$/i.test(file))
const stray = files.filter((file) => !places.some((place) => matchesGlob(file, place)))

if (stray.length > 0) {
  console.error("Markdown outside the places this repo keeps docs. Put the reason in the commit message or the PR, not in a new file:")
  for (const file of stray) console.error(`  ${file}`)
  console.error(`Places: ${places.join(", ")}. Adding a place is a change to tooling/markdown-places.mjs that review sees.`)
  process.exitCode = 1
} else console.log(`markdown-places: ${files.length} Markdown files, all in their places`)
