// Runs, on the replay copy, the check the server runs each minute for Memory files changed
// outside Arden, and prints what it did by page path: the changes it took in, the pages it set
// aside with the reason, the files not in Memory, and each page's last change made outside,
// read from history.
// It prints no page text.
//
// Run it with `just memory-outside-edits <replay folder>`. It opens the copy only through
// test/fixtures/replay-copy.ts, which refuses the owner's real data: no server, no model.

import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect, Layer, References } from "effect"
import { it } from "vitest"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { decodeWikiOrigin } from "../src/wiki/commit.js"
import type { OutsideEditCheck } from "../src/wiki/outside-edits.js"
import { Wiki, wikiLayer } from "../src/wiki/service.js"
import { locateReplayCopy, runOnReplayCopy } from "../test/fixtures/replay-copy.js"

const report = (title: string, checked: OutsideEditCheck): ReadonlyArray<string> => [
  title,
  `  Taken in, one commit each: ${checked.takenIn.length}`,
  ...checked.takenIn.map((item) => `    ${item.action}  ${item.path}`),
  `  Set aside, recall keeps the last good version: ${checked.setAside.length}`,
  ...checked.setAside.map((item) => `    ${item.reason}  ${item.path}: ${item.detail}`),
  `  Settling, decided at the next check if unchanged: ${checked.settling.length}`,
  ...checked.settling.map((path) => `    ${path}`),
  `  Changed again during the check, decided next time: ${checked.changedDuringCheck.length}`,
  ...checked.changedDuringCheck.map((path) => `    ${path}`),
  `  Not in Memory (.md files Arden never added): ${checked.notInMemory.length}`,
  ...checked.notInMemory.map((path) => `    ${path}`),
  `  Other files in the Memory folder, not pages: ${checked.otherFiles.length}`,
  ...checked.otherFiles.map((path) => `    ${path}`),
  `  Files or folders that could not be read: ${checked.unreadableFiles.length}`,
  ...checked.unreadableFiles.map((item) => `    ${item.path}: ${item.reason}`)
]

it("checks the copy's Memory folder for changes made outside Arden", async () => {
  const located = locateReplayCopy()
  if (located.kind === "absent") throw new Error(located.reason)
  const copy = located.copy
  const roots = {
    workingRoot: join(copy.wiki, "pages"),
    historyRoot: join(copy.wiki, ".wiki-history")
  }
  const wiki = wikiLayer(roots).pipe(Layer.provide(automationWikiChangeSinkLayer))
  const quiet = Effect.provideService(References.MinimumLogLevel, "Error")

  // The server decides about a file once it has stayed the same for one poll, so the recipe runs
  // the check twice, as two polls would.
  const checks = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const memory = yield* Wiki
      const first = yield* memory.checkOutsideEdits()
      const second = yield* memory.checkOutsideEdits()
      return [...report("First check:", first), ...report("Second check, one poll later:", second)]
    }).pipe(Effect.provide(wiki), quiet)
  )
  const outside = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const newest = new Map<string, string>()
      for (const commit of yield* repository.history()) {
        const origin = decodeWikiOrigin(commit.origin)
        if (origin.kind !== "user" || origin.via !== "filesystem") continue
        for (const change of commit.changes) {
          const version = change.after ?? change.before
          if (version === null || newest.has(version.resourceId)) continue
          newest.set(version.resourceId, `${commit.timestamp}  ${change.action}  ${version.path}`)
        }
      }
      return [...newest.values()].sort()
    }).pipe(Effect.provide(managedFileRepositoryNodeLayer(roots)), quiet)
  )
  process.stdout.write(
    `${[
      ...checks,
      `Pages whose last outside change is in history: ${outside.length}`,
      ...outside.map((line) => `  ${line}`)
    ].join("\n")}\n`
  )
})
