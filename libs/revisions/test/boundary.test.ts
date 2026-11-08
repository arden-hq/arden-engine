import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const Manifest = Schema.Struct({
  exports: Schema.Record(
    Schema.String,
    Schema.Struct({ types: Schema.String, import: Schema.String })
  ),
  files: Schema.Array(Schema.String)
})
const manifest = Schema.decodeUnknownSync(Manifest)(
  JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
)

describe("package boundary", () => {
  it("exports only built files", () => {
    expect(Object.keys(manifest.exports).some((key) => key.includes("*"))).toBe(false)
    expect(
      Object.values(manifest.exports)
        .flatMap((entry) => [entry.types, entry.import])
        .every((target) => target.startsWith("./dist/"))
    ).toBe(true)
    expect(
      Object.values(manifest.exports)
        .flatMap((entry) => [entry.types, entry.import])
        .every((target) => existsSync(resolve(packageRoot, target)))
    ).toBe(true)
    expect(manifest.files).not.toContain("src")
    expect(manifest.files).toContain("README.md")
    expect(manifest.files).toContain("LICENSE")
  })
})
