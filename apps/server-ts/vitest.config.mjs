import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig, mergeConfig } from "vitest/config"

import root from "../../vitest.config.mjs"

const testDirectory = new URL("./test/", import.meta.url)
const boot = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) =>
    /\b(startServer|startConfigured)\(/.test(readFileSync(new URL(name, testDirectory), "utf8"))
  )
  .map((name) => `test/${name}`)

// The growth check seeds two large databases and takes minutes: it runs only
// in its own project, from `just speed` (the last step of `just check`).
const speed = ["test/sql-speed/**/*.test.ts"]
const speedProject =
  process.env.ARDEN_SQL_SPEED === "1"
    ? [{ extends: true, test: { name: "speed", include: speed, testTimeout: 1_200_000 } }]
    : []

// The Capture backlog count is a script on the replay copy, not a test: it runs only in its
// own project, from `just capture-backlog`.
const backlogProject =
  process.env.ARDEN_CAPTURE_BACKLOG === "1"
    ? [
        {
          extends: true,
          test: { name: "capture-backlog", include: ["scripts/capture-backlog-count.ts"] }
        }
      ]
    : []

// The SQLite threads write here every table scan the tests cause; the check
// in test/sql-scans/global.ts reads it after the run.
const scanLog = fileURLToPath(new URL("../../node_modules/.cache/sql-scans/", import.meta.url))
rmSync(scanLog, { recursive: true, force: true })
mkdirSync(scanLog, { recursive: true })
// Set here as well as in `test.env`: the check runs in this process, the tests in workers.
process.env.ARDEN_SQL_SCAN_LOG = scanLog

export default mergeConfig(
  root,
  defineConfig({
    test: {
      env: { ARDEN_SQL_SCAN_LOG: scanLog },
      sequence: { shuffle: true },
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            exclude: [...configDefaults.exclude, ...boot, ...speed],
            isolate: false
          }
        },
        // The boot project carries the scan check: its teardown runs once, after both projects.
        {
          extends: true,
          test: { name: "boot", include: boot, globalSetup: ["./test/sql-scans/global.ts"] }
        },
        ...speedProject,
        ...backlogProject
      ]
    }
  })
)
