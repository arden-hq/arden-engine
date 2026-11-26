import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig, mergeConfig } from "vitest/config"

import { FLAG, MEMORY_TEST_HALF } from "../../tooling/value-tables.mjs"
import root from "../../vitest.config.mjs"

const testDirectory = new URL("./test/", import.meta.url)
const boot = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) =>
    /\b(startServer|startConfigured)\(/.test(readFileSync(new URL(name, testDirectory), "utf8"))
  )
  .map((name) => `test/${name}`)

const speed = ["test/sql-speed/**/*.test.ts"]
const speedProject =
  process.env.ARDEN_SQL_SPEED === FLAG.on
    ? [{ extends: true, test: { name: "speed", include: speed, testTimeout: 1_200_000 } }]
    : []

const memoryTestHalf = process.env.ARDEN_MEMORY_TEST
const memoryTestProject =
  memoryTestHalf === MEMORY_TEST_HALF.sent || memoryTestHalf === MEMORY_TEST_HALF.answered
    ? [
        {
          extends: true,
          test: { name: "memory-test", include: [`scripts/memory-test-${memoryTestHalf}.ts`] }
        }
      ]
    : []

const outsideEditsProject =
  process.env.ARDEN_OUTSIDE_EDITS === FLAG.on
    ? [
        {
          extends: true,
          test: { name: "outside-edits", include: ["scripts/memory-outside-edits.ts"] }
        }
      ]
    : []

const memoryShapeProject =
  process.env.ARDEN_MEMORY_SHAPE === FLAG.on
    ? [{ extends: true, test: { name: "memory-shape", include: ["scripts/memory-shape.ts"] } }]
    : []

const scanLog = fileURLToPath(new URL("../../node_modules/.cache/sql-scans/", import.meta.url))
rmSync(scanLog, { recursive: true, force: true })
mkdirSync(scanLog, { recursive: true })
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
