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

// The memory test's two halves are scripts on the replay copy, not tests: each runs only in its
// own project, from `just memory-test-sent` or `just memory-test-answered`.
const memoryTestHalf = process.env.ARDEN_MEMORY_TEST
const memoryTestProject =
  memoryTestHalf === "sent" || memoryTestHalf === "answered"
    ? [
        {
          extends: true,
          test: { name: "memory-test", include: [`scripts/memory-test-${memoryTestHalf}.ts`] }
        }
      ]
    : []

const outsideEditsProject =
  process.env.ARDEN_OUTSIDE_EDITS === "1"
    ? [
        {
          extends: true,
          test: { name: "outside-edits", include: ["scripts/memory-outside-edits.ts"] }
        }
      ]
    : []

// The replays read one copy of real data and each holds it while it runs: they run one file at
// a time, in their own project, with room to wait for each other.
const replays = ["test/*-replay.test.ts"]

const memoryShapeProject =
  process.env.ARDEN_MEMORY_SHAPE === "1"
    ? [{ extends: true, test: { name: "memory-shape", include: ["scripts/memory-shape.ts"] } }]
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
            exclude: [...configDefaults.exclude, ...boot, ...speed, ...replays],
            isolate: false
          }
        },
        {
          extends: true,
          test: {
            name: "replay",
            include: replays,
            fileParallelism: false,
            testTimeout: 1_800_000
          }
        },
        // The boot project carries the scan check: its teardown runs once, after both projects.
        {
          extends: true,
          test: { name: "boot", include: boot, globalSetup: ["./test/sql-scans/global.ts"] }
        },
        ...speedProject,
        ...memoryTestProject,
        ...outsideEditsProject,
        ...memoryShapeProject
      ]
    }
  })
)
