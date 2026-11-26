import { execFileSync, spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { baselinedRules } from "./lint-plugin.mjs"

const root = resolve(import.meta.dirname, "..")
const oxlint = resolve(root, "node_modules/oxlint/bin/oxlint")

const directiveLines = (() => {
  try {
    return execFileSync("git", ["grep", "-nE", "(//|/\\*)[[:space:]]*(oxlint|eslint)-disable", "--", ":(exclude)tooling/lint-plugin.mjs", ":(exclude)tooling/lint.mjs"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    })
      .split("\n")
      .filter((line) => line !== "")
  } catch {
    return []
  }
})()
const baselinedNames = new Set(baselinedRules.map(({ rule }) => `arden/${rule}`))
const disabledBaselined = directiveLines.filter((line) => {
  const directive = line.match(/(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(.*)$/)
  if (directive === null) return false
  const ruleList = directive[1].split(/\s--\s|\*\//)[0].trim()
  if (ruleList === "") return true
  return ruleList.split(/[\s,]+/).some((name) => baselinedNames.has(name))
})
if (disabledBaselined.length > 0) {
  console.error("These lines switch off every rule, or a rule that has a baseline. Name the rule you switch off, and never a baselined one: fix the case instead, old cases are already allowed:")
  for (const line of disabledBaselined) console.error(`  ${line}`)
  process.exitCode = 1
}

const result = spawnSync(
  process.execPath,
  [oxlint, "--report-unused-disable-directives-severity=error", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" }
)
process.exitCode = Math.max(process.exitCode ?? 0, result.status ?? 1)
