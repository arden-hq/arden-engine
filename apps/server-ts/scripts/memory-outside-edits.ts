// Runs, on the replay copy, the check the server runs each minute for Memory files changed
// outside Arden, and prints what it did by page path: the changes it took in, the pages it set
// aside with the reason, the files not in Memory, and each page's last change made outside.
// It prints no page text.
//
// Run it with `just memory-outside-edits <replay folder>`. It opens the copy only through
// test/fixtures/replay-copy.ts, which refuses the owner's real data: no server, no model.

import { join } from "node:path"
import { Effect, Layer, References } from "effect"
import { it } from "vitest"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { Wiki, wikiLayer } from "../src/wiki/service.js"
import { locateReplayCopy, runOnReplayCopy } from "../test/fixtures/replay-copy.js"

it("checks the copy's Memory folder for changes made outside Arden", async () => {
  const located = locateReplayCopy()
  if (located.kind === "absent") throw new Error(located.reason)
  const copy = located.copy
  const wiki = wikiLayer({
    workingRoot: join(copy.wiki, "pages"),
    historyRoot: join(copy.wiki, ".wiki-history")
  }).pipe(Layer.provide(automationWikiChangeSinkLayer))

  const lines = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const memory = yield* Wiki
      const checked = yield* memory.checkOutsideEdits()
      const snapshot = yield* memory.snapshot()
      const times = yield* memory.pageTimes(snapshot.head)
      const paths = new Map(
        snapshot.pages.map((record) => [record.page.pageId, record.resource.path])
      )
      const outside = [...times]
        .flatMap(([pageId, time]) =>
          time.outside === null
            ? []
            : [
                `${time.outside.at}  ${time.outside.action}  ${paths.get(pageId) ?? `archived page ${pageId}`}`
              ]
        )
        .sort()
      return [
        `Taken in, one commit each: ${checked.takenIn.length}`,
        ...checked.takenIn.map((item) => `  ${item.action}  ${item.path}`),
        `Set aside, recall keeps the last good version: ${checked.setAside.length}`,
        ...checked.setAside.map((item) => `  ${item.reason}  ${item.path}: ${item.detail}`),
        `Changed again during the check, taken in next time: ${checked.changedDuringCheck.length}`,
        ...checked.changedDuringCheck.map((path) => `  ${path}`),
        `Not in Memory (.md files Arden never added): ${checked.notInMemory.length}`,
        ...checked.notInMemory.map((path) => `  ${path}`),
        `Other files in the Memory folder, not pages: ${checked.otherFiles.length}`,
        ...checked.otherFiles.map((path) => `  ${path}`),
        `Pages whose last outside change is in history: ${outside.length}`,
        ...outside.map((line) => `  ${line}`)
      ]
    }).pipe(Effect.provide(wiki), Effect.provideService(References.MinimumLogLevel, "Error"))
  )
  process.stdout.write(`${lines.join("\n")}\n`)
})
