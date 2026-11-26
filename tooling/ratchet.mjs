import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { parseJson, readJsonFileSync } from "./json-edge.mjs"
import { baselinedOverrides, baselinedRules } from "./lint-plugin.mjs"

const root = resolve(import.meta.dirname, "..")
const seed = process.argv.includes("--seed")

const run = (rule, paths) => {
  const config = resolve(root, `.oxlintrc.ratchet-${process.pid}.json`)
  writeFileSync(config, JSON.stringify({ categories: { correctness: "off" }, plugins: [], jsPlugins: [resolve(root, "tooling/lint-plugin.mjs")], overrides: baselinedOverrides.filter((override) => Object.hasOwn(override.rules, `arden/${rule}`)) }))
  try {
    return execFileSync(process.execPath, [resolve(root, "node_modules/oxlint/bin/oxlint"), "-c", config, "-f", "json", ...paths], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ARDEN_BASELINE_COUNT: "1" }
    })
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.startsWith("{")) return error.stdout
    throw error
  } finally {
    rmSync(config, { force: true })
  }
}


const scan = (rule) => {
  const report = parseJson(run(rule, ["."]))
  if (report.number_of_files === 0) throw new Error(`ratchet: oxlint read no files for ${rule}; no baseline was written.`)
  const now = {}
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.code !== `arden(${rule})`)
      throw new Error(`ratchet: ${diagnostic.filename}: ${diagnostic.message}. Fix it, then run the ratchet again; no baseline was written.`)
    const name = relative(root, resolve(root, diagnostic.filename))
    now[name] = (now[name] ?? 0) + 1
  }
  return now
}

const results = baselinedRules.map(({ rule, baseline }) => {
  const now = scan(rule)
  const was = readJsonFileSync(resolve(root, baseline))
  const kept = (seed ? Object.entries(now) : Object.entries(was).map(([name, count]) => [name, Math.min(count, now[name] ?? 0)]))
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  return { rule, baseline, kept }
})
for (const { rule, baseline, kept } of results) {
  writeFileSync(resolve(root, baseline), `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`)
  console.log(`${rule}: ${kept.reduce((sum, [, count]) => sum + count, 0)} in ${kept.length} files`)
}
