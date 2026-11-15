import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const SOURCE = join(import.meta.dirname, "../src")
const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [relative(SOURCE, path)] : []
  })
const naming = (pattern: RegExp): ReadonlyArray<string> =>
  sources(SOURCE)
    .filter((path) => pattern.test(readFileSync(join(SOURCE, path), "utf8")))
    .sort()

it("names the producer marker only where it is read for the predicate or written", () => {
  expect(naming(/producer_automation_id|WIKI_REPORT_FIELDS\.automationId/u)).toEqual([
    "wiki/collections.ts",
    "wiki/directories.ts",
    "wiki/reports.ts"
  ])
})

it("decides what an automated writer may do only in write-rules.ts", () => {
  expect(naming(/\bisAutomatedOrigin\(/u)).toEqual(["wiki/write-rules.ts"])
})
