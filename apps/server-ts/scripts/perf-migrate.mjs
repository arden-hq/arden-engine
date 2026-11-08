#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { constants, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DatabaseSync } from "node:sqlite"
import { errorMessage } from "@arden-hq/std/errors"
import { LATEST_SCHEMA_VERSION } from "../dist/persistence/migrations/index.js"
import {
  openDatabaseForMigration,
  pendingMigrationSteps,
  planMigrations
} from "../dist/persistence/migrations/runner.js"

const usage = `Usage:
  node scripts/perf-migrate.mjs <arden.db> [--from <version> | --tag <vX.Y.Z>] [--max-ms 2000]
                                [--work-dir <dir>] [--keep]

Copies <arden.db> (quit Arden first, or pass a copy), sets the copy's user_version back to
the last released tag's migration version (or --from / --tag), runs every pending migration
and prints each one's time. Exits 1 when any single migration takes longer than --max-ms.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    tag: { type: "string" },
    "max-ms": { type: "string", default: "2000" },
    "work-dir": { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  }
})

if (values.help || positionals.length !== 1) {
  console.log(usage)
  process.exit(values.help ? 0 : 2)
}

const fail = (message) => {
  console.error(`perf-migrate: ${message}`)
  process.exit(2)
}

const source = resolve(positionals[0])
if (!existsSync(source)) fail(`${source} does not exist`)
const maxMs = Number(values["max-ms"])
if (!Number.isFinite(maxMs) || maxMs <= 0) fail("--max-ms must be a positive number")

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const MIGRATIONS_DIR = "apps/server-ts/src/persistence/migrations"

const versionAtTag = (tag) => {
  const files = execFileSync("git", ["ls-tree", "--name-only", `${tag}:${MIGRATIONS_DIR}`], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const versions = files
    .split("\n")
    .flatMap((name) => /^(\d{4})_\w+\.ts$/.exec(name)?.[1] ?? [])
    .map(Number)
  if (versions.length === 0) fail(`${tag} has no migrations under ${MIGRATIONS_DIR}`)
  return Math.max(...versions)
}

const lastReleaseTag = () =>
  execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim()

const tag = values.from === undefined ? (values.tag ?? lastReleaseTag()) : undefined
const from = values.from === undefined ? versionAtTag(tag) : Number(values.from)
if (!Number.isSafeInteger(from) || from < 1) fail("--from must be a migration version (1 or more)")
if (from >= LATEST_SCHEMA_VERSION) {
  console.log(
    `Nothing to time: ${tag ?? `version ${from}`} is already at migration ${from}, and this build's latest is ${LATEST_SCHEMA_VERSION}.`
  )
  process.exit(0)
}

const ardenRoot = resolve(homedir(), ".arden")
const ownWorkDir = values["work-dir"] === undefined
const workDir = resolve(values["work-dir"] ?? mkdtempSync(join(tmpdir(), "arden-perf-migrate-")))
if (workDir === ardenRoot || workDir.startsWith(`${ardenRoot}/`))
  fail("--work-dir must not be inside ~/.arden")
const copy = join(workDir, "arden.db")
if (existsSync(copy)) fail(`${copy} already exists; pass an empty --work-dir`)
const removeCopy = () => {
  if (values.keep) return
  if (ownWorkDir) rmSync(workDir, { recursive: true, force: true })
  else for (const suffix of ["", "-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true })
}

for (const suffix of ["", "-wal"]) {
  if (existsSync(`${source}${suffix}`))
    copyFileSync(`${source}${suffix}`, `${copy}${suffix}`, constants.COPYFILE_FICLONE)
}

const rewind = new DatabaseSync(copy)
const found = rewind.prepare("PRAGMA user_version").get()?.user_version
rewind.exec(`PRAGMA user_version = ${from}`)
rewind.close()

console.log(`source    ${source}`)
console.log(`copy      ${copy}`)
console.log(`released  ${tag ?? "(--from)"} = migration ${from}; copy was at ${found}`)
console.log(`limit     ${maxMs} ms per migration`)
if (typeof found === "number" && found > from)
  console.log(
    `note      the copy already had migrations ${from + 1}..${found}; one that is not idempotent fails here — use a database from the released app`
  )
console.log("")

const database = openDatabaseForMigration(copy)
let failed = false
const slow = []
try {
  const plan = planMigrations(database)
  const steps = plan.kind === "pending" ? pendingMigrationSteps(plan) : []
  if (plan.kind !== "pending") {
    console.error(`perf-migrate: expected pending migrations, found ${plan.kind}`)
    failed = true
  }
  for (const step of steps) {
    const started = performance.now()
    try {
      step.run(database)
    } catch (cause) {
      console.log(`${String(step.version).padStart(4, "0")}  ${step.name.padEnd(32)}  FAILED`)
      console.error(errorMessage(cause))
      failed = true
      break
    }
    const ms = performance.now() - started
    if (ms > maxMs) slow.push(step)
    console.log(
      `${String(step.version).padStart(4, "0")}  ${step.name.padEnd(32)}  ${ms.toFixed(0).padStart(7)} ms${ms > maxMs ? "  OVER" : ""}`
    )
  }
} finally {
  database.close()
  removeCopy()
}

if (failed) process.exit(2)
if (slow.length > 0) {
  console.log(
    `\n${slow.length} migration(s) over ${maxMs} ms: ${slow.map((step) => step.name).join(", ")}. Keep the migration to schema and cheap work; move the heavy row work into a background backfill (AGENTS.md, "Database changes").`
  )
  process.exit(1)
}
console.log(`\nEvery migration finished within ${maxMs} ms.`)
