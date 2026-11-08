import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("public boundary", () => {
  it("produces an executable Node-target bundle from the public root", () => {
    const directory = mkdtempSync(join(tmpdir(), "arden-loop-bundle-"))
    temporaryDirectories.push(directory)
    const entry = join(directory, "entry.mjs")
    const output = join(directory, "loop.mjs")
    const publicRoot = join(packageRoot, "dist/index.js")

    writeFileSync(
      entry,
      [
        `import { InvalidAgentConfigError, createTool, createToolset, makeAgent, makeRunBudget } from ${JSON.stringify(publicRoot)}`,
        `if (typeof makeAgent !== "function") throw new Error("missing makeAgent")`,
        `if (typeof createTool !== "function") throw new Error("missing createTool")`,
        `if (typeof createToolset !== "function") throw new Error("missing createToolset")`,
        `if (typeof makeRunBudget !== "function") throw new Error("missing makeRunBudget")`,
        `if (!(new InvalidAgentConfigError("test") instanceof Error)) throw new Error("invalid public error")`
      ].join("\n")
    )

    execFileSync("bun", ["build", entry, "--target=node", `--outfile=${output}`], { stdio: "pipe" })
    expect(() => execFileSync("node", [output], { stdio: "pipe" })).not.toThrow()
  })
})
