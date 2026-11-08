// Engine releases. Every package shares one version.
//
//   node tooling/release.mjs version 0.2.0   set that version in every workspace package
//   node tooling/release.mjs publish         publish every public package whose version is not on npm yet
//
// `just release 0.2.0` runs `version`, commits and tags v0.2.0. Pushing the tag
// starts .github/workflows/release.yml, which runs `publish` with npm trusted
// publishing (no token). A new package needs one manual first publish, then
// Settings → Trusted Publisher on npmjs.com: arden-hq / arden-engine / release.yml. `publish` packs each package with Bun, so `workspace:*`
// and `catalog:` become real versions, then publishes the tarball with npm,
// dependencies first. A version already on npm is skipped, so a failed run can
// simply run again.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const license = readFileSync(path.join(root, "LICENSE"), "utf8")

/** Every workspace package: { dir, file, json }. */
const workspaces = () =>
  rootPackage.workspaces.packages
    .flatMap((pattern) =>
      pattern.endsWith("/*")
        ? readdirSync(path.join(root, pattern.slice(0, -2))).map((name) => `${pattern.slice(0, -2)}/${name}`)
        : [pattern]
    )
    .map((dir) => ({ dir, file: path.join(root, dir, "package.json") }))
    .filter(({ file }) => existsSync(file))
    .map(({ dir, file }) => ({ dir, file, json: JSON.parse(readFileSync(file, "utf8")) }))

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const setVersion = (version) => {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) fail("Usage: release.mjs version X.Y.Z")
  for (const { file, json } of workspaces()) {
    json.version = version
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  }
  // Bun packs `workspace:*` with the version bun.lock records for each
  // workspace, and `bun install` never refreshes it, so write it here.
  const lockPath = path.join(root, "bun.lock")
  const lock = readFileSync(lockPath, "utf8").replace(
    /("name": "@arden-hq\/[^"]+",\s*"version": ")[^"]+"/g,
    (_, head) => `${head}${version}"`
  )
  writeFileSync(lockPath, lock)
  console.log(`Every package is now ${version}.`)
}

/** Public packages, each after the packages it depends on. */
const publishOrder = () => {
  const open = workspaces().filter(({ json }) => json.private !== true)
  const names = new Set(open.map(({ json }) => json.name))
  const ordered = []
  const placed = new Set()
  while (ordered.length < open.length) {
    const ready = open.filter(
      ({ json }) =>
        !placed.has(json.name) &&
        Object.keys({ ...json.dependencies, ...json.peerDependencies })
          .filter((name) => names.has(name))
          .every((name) => placed.has(name))
    )
    if (ready.length === 0) fail("The public packages depend on each other in a cycle.")
    for (const entry of ready) {
      ordered.push(entry)
      placed.add(entry.json.name)
    }
  }
  return ordered
}

const onNpm = (name, version) => {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

const publish = () => {
  const packages = publishOrder()
  const versions = new Set(workspaces().map(({ json }) => json.version))
  if (versions.size !== 1) fail(`Packages have different versions: ${[...versions].join(", ")}.`)
  const [version] = versions
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined
  if (tag !== undefined && tag !== `v${version}`) fail(`Tag ${tag} does not match version ${version}.`)
  for (const { dir, json } of packages) {
    const own = path.join(root, dir, "LICENSE")
    if (!existsSync(own) || readFileSync(own, "utf8") !== license) fail(`${dir}/LICENSE must be a copy of LICENSE.`)
    if (json.private !== true && json.publishConfig?.access !== "public")
      fail(`${json.name} needs "publishConfig": { "access": "public" }.`)
  }
  const out = mkdtempSync(path.join(tmpdir(), "arden-engine-pack-"))
  const provenance = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : []
  for (const { dir, json } of packages) {
    if (onNpm(json.name, version)) {
      console.log(`${json.name}@${version} is already on npm.`)
      continue
    }
    const before = new Set(readdirSync(out))
    execFileSync("bun", ["pm", "pack", "--destination", out], { cwd: path.join(root, dir), stdio: "inherit" })
    const tarball = readdirSync(out).find((name) => !before.has(name))
    if (tarball === undefined) fail(`Bun did not pack ${json.name}.`)
    const packed = JSON.parse(
      execFileSync("tar", ["-xzOf", path.join(out, tarball), "package/package.json"], { encoding: "utf8" })
    )
    const stale = Object.entries({ ...packed.dependencies, ...packed.peerDependencies }).filter(
      ([name, spec]) => name.startsWith("@arden-hq/") && spec !== version
    )
    if (stale.length > 0)
      fail(`${json.name} would depend on ${stale.map(([name, spec]) => `${name}@${spec}`).join(", ")}, not ${version}.`)
    const result = spawnSync("npm", ["publish", path.join(out, tarball), "--access", "public", ...provenance], {
      encoding: "utf8",
      stdio: ["ignore", "inherit", "pipe"]
    })
    process.stderr.write(result.stderr)
    // `npm view` can lag a fresh publish by minutes, so a rerun may try a version
    // that is already there; npm answers 409 and the run moves on.
    if (result.status !== 0 && /E409|cannot publish over/i.test(result.stderr)) {
      console.log(`${json.name}@${version} is already on npm.`)
      continue
    }
    if (result.status !== 0) fail(`npm publish failed for ${json.name}@${version}.`)
    console.log(`Published ${json.name}@${version}.`)
  }
}

const [mode, argument] = process.argv.slice(2)
if (mode === "version") setVersion(argument)
else if (mode === "publish") publish()
else fail("Usage: node tooling/release.mjs version X.Y.Z | publish")
