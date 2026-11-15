import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect, References } from "effect"
import { it } from "vitest"
import { FINDING_KINDS, FINDINGS, memoryFindings } from "../src/wiki/page-shape.js"
import { loadSnapshot } from "../src/wiki/snapshot.js"
import { UNTRACKED_PAGES } from "../src/wiki/untracked.js"
import { locateReplayCopy } from "../test/fixtures/replay-copy.js"

// Reads the copy's Memory files only: the database is not opened, so no migration runs.
it("prints the findings on the copy's Memory, paths and counts only", async () => {
  const located = locateReplayCopy()
  if (located.kind === "absent") throw new Error(located.reason)
  const copy = located.copy
  const roots = {
    workingRoot: join(copy.wiki, "pages"),
    historyRoot: join(copy.wiki, ".wiki-history")
  }
  const findings = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const snapshot = yield* loadSnapshot(repository, "list")
      const status = yield* repository.workingTreeStatus(UNTRACKED_PAGES)
      return {
        pages: snapshot.pages.length,
        untracked: status.untracked.length,
        findings: memoryFindings({ pages: snapshot.pages, untracked: status.untracked })
      }
    }).pipe(
      Effect.provide(managedFileRepositoryNodeLayer(roots)),
      Effect.provideService(References.MinimumLogLevel, "Error")
    )
  )
  const lines = [
    `Pages in history: ${findings.pages}; other files in the folder: ${findings.untracked}`,
    ...FINDING_KINDS.flatMap((kind) => {
      const ofKind = findings.findings.filter((finding) => finding.kind === kind)
      const pages = new Set(ofKind.flatMap((finding) => finding.paths))
      return [
        `${kind}: ${ofKind.length} (${pages.size} paths), ${FINDINGS[kind]}`,
        ...ofKind.map((finding) => `  ${finding.paths.join("  ")}`)
      ]
    })
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
})
