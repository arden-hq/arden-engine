import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const oxlint = resolve(root, "node_modules/oxlint/bin/oxlint")
const result = spawnSync(
  process.execPath,
  [oxlint, "--report-unused-disable-directives-severity=error", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" }
)
process.exitCode = result.status ?? 1
