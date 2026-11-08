import { readdirSync, readFileSync } from "node:fs"
import { configDefaults, defineConfig, mergeConfig } from "vitest/config"

import root from "../../vitest.config.mjs"

const testDirectory = new URL("./test/", import.meta.url)
const boot = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => /\bstartServer\(/.test(readFileSync(new URL(name, testDirectory), "utf8")))
  .map((name) => `test/${name}`)

export default mergeConfig(
  root,
  defineConfig({
    test: {
      sequence: { shuffle: true },
      projects: [
        {
          extends: true,
          test: { name: "unit", exclude: [...configDefaults.exclude, ...boot], isolate: false }
        },
        { extends: true, test: { name: "boot", include: boot } }
      ]
    }
  })
)
