import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseJson, readJsonFileSync } from "./json-edge.mjs"

const root = process.cwd()
const args = process.argv.slice(2)
const base = args.find((arg) => !arg.startsWith("--")) ?? "origin/main"
const bodyFile = args.find((arg) => arg.startsWith("--pr-body="))?.slice("--pr-body=".length)
const knownViolations = ".dependency-cruiser-known-violations.json"
const baselineDir = "tooling/baselines"
const checkFiles = [
  /^oxlint\.config\.ts$/,
  /^\.dependency-cruiser\.cjs$/,
  /^knip\.json$/,
  /^justfile$/,
  /^tooling\/(?!baselines\/)/,
  /^\.github\//,
  /^\.githooks\//,
  /^apps\/desktop\/(lint\.[^/]+\.mjs|contracts\/)/
]

const git = (gitArgs) =>
  execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })

const fail = (lines) => {
  for (const line of lines) console.error(line)
  process.exitCode = 1
}

try {
  git(["rev-parse", "--verify", `${base}^{commit}`])
} catch {
  fail([`checks-only-tighten: the base "${base}" is not a commit here. Fetch it first.`])
  process.exit()
}

const atBase = (path) => {
  try {
    return parseJson(git(["show", `${base}:${path}`]))
  } catch {
    return undefined
  }
}
const atHead = (path) => (existsSync(resolve(root, path)) ? readJsonFileSync(resolve(root, path)) : undefined)

const changed = []
const fields = git(["diff", "-z", "--name-status", "-M", base, "--"]).split("\0")
for (let index = 0; index < fields.length - 1; ) {
  const status = fields[index]
  const paths = status.startsWith("R") || status.startsWith("C") ? [fields[index + 1], fields[index + 2]] : [fields[index + 1]]
  changed.push([status, ...paths])
  index += 1 + paths.length
}
const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter((line) => line !== "")
const renames = changed.filter(([status]) => status.startsWith("R")).map(([, from, to]) => [from, to])
const changedPaths = [...changed.flatMap(([, ...paths]) => paths), ...untracked]

const samePath = (path, key) => path === key || path === `apps/desktop/${key}`
const renamedPath = (oldKey, newKey) => oldKey === newKey || renames.some(([from, to]) => samePath(from, oldKey) && samePath(to, newKey))

const splitKey = (key) => (key.includes("|") ? [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)] : ["", key])
const renamedTo = (oldKey, newKey) => {
  const [oldGroup, oldRest] = splitKey(oldKey)
  const [newGroup, newRest] = splitKey(newKey)
  if (oldGroup !== newGroup) return false
  const oldParts = oldRest.split(" → ")
  const newParts = newRest.split(" → ")
  return oldParts.length === newParts.length && oldParts.every((part, index) => renamedPath(part, newParts[index]))
}

const leaves = (json, path = [], out = new Map(), bad = [], groups = new Set()) => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return { out, bad, groups }
  groups.add(path.join(" › "))
  for (const [key, value] of Object.entries(json)) {
    const name = [...path, key]
    if (typeof value === "number" && Number.isFinite(value)) out.set(name.join(" › "), { count: value, key })
    else if (value === null) out.set(name.join(" › "), { count: 0, key })
    else if (typeof value === "object" && !Array.isArray(value)) leaves(value, name, out, bad, groups)
    else bad.push(name.join(" › "))
  }
  return { out, bad, groups }
}

const isNewGroup = (before, name, key) => {
  const parent = name.split(" › ").slice(0, -1).join(" › ")
  if (parent !== "") return !before.groups.has(parent)
  const [group] = splitKey(key)
  return group !== "" && ![...before.out.values()].some((old) => splitKey(old.key)[0] === group)
}

const compareFile = (file, before, after, newGroupsAllowed) => {
  const problems = after.bad.map((name) => `${file} › ${name}: not a number`)
  const gone = [...before.out.keys()].filter((name) => !after.out.has(name))
  for (const [name, { count, key }] of after.out) {
    const was = before.out.get(name)
    if (was !== undefined) {
      if (count > was.count) problems.push(`${file} › ${name}: ${was.count} → ${count}`)
      continue
    }
    if (newGroupsAllowed && isNewGroup(before, name, key)) continue
    const source = gone.find((oldName) => renamedTo(before.out.get(oldName).key, key))
    if (source === undefined) {
      if (count > 0) problems.push(`${file} › ${name}: new, ${count}`)
    } else if (count > before.out.get(source).count) problems.push(`${file} › ${name}: ${before.out.get(source).count} → ${count} (renamed)`)
  }
  return problems
}

const listedAtBase = () => {
  try {
    return git(["ls-tree", "--name-only", `${base}:${baselineDir}`]).split("\n").filter((name) => name !== "").map((name) => `${baselineDir}/${name}`)
  } catch {
    return []
  }
}
const baselineFiles = [...new Set([...git(["ls-files", "--others", "--cached", "--", baselineDir]).split("\n"), ...listedAtBase()])]
  .filter((name) => name.endsWith(".json"))
  .sort()

const violationCounts = (list) => {
  const out = new Map()
  for (const violation of list ?? []) {
    const key = `${violation.rule.name}|${violation.from} → ${violation.to}`
    out.set(key, { count: (out.get(key)?.count ?? 0) + 1, key })
  }
  return { out, bad: [], groups: new Set() }
}

const raised = [
  ...baselineFiles.flatMap((file) => {
    const before = atBase(file)
    return before === undefined ? [] : compareFile(file, leaves(before), leaves(atHead(file)), true)
  }),
  ...compareFile(knownViolations, violationCounts(atBase(knownViolations)), violationCounts(atHead(knownViolations)), false)
]

if (raised.length > 0)
  fail([
    `These counts went up compared with ${base}. A change may only lower them:`,
    ...raised.map((line) => `  ${line}`),
    "Fix the new cases instead. A file that git sees as renamed keeps its count under the new name."
  ])

const packageFiles = changedPaths.filter((path) => /(^|\/)package\.json$/.test(path))
const scriptsChanged = packageFiles.filter((path) => JSON.stringify(atBase(path)?.scripts ?? {}) !== JSON.stringify(atHead(path)?.scripts ?? {}))
const touchedChecks = [...changedPaths.filter((path) => checkFiles.some((pattern) => pattern.test(path))), ...scriptsChanged.map((path) => `${path} (scripts)`)]
if (bodyFile !== undefined && touchedChecks.length > 0) {
  const body = existsSync(bodyFile) ? readFileSync(bodyFile, "utf8") : ""
  if (!/^Checks change: \S/m.test(body))
    fail([
      "This change edits the files that define the checks:",
      ...touchedChecks.map((path) => `  ${path}`),
      'Say why in the PR description, on a line that starts with "Checks change: ". This check runs again when the description changes.'
    ])
}

if (process.exitCode !== 1) console.log(`checks-only-tighten: no count went up compared with ${base}`)
