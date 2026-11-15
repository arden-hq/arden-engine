import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { SpaceStore, type SpaceBindingRow } from "../src/persistence/spaces/store.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import type { PageRecord } from "../src/wiki/snapshot.js"
import {
  bindingOwnsPath,
  planSpacePage,
  spaceBinding,
  spaceOwnsWikiPath,
  spacePageIndex,
  spacePages
} from "../src/wiki/space-index.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"

const located = locateReplayCopy()

const heldOnlyByArchived = (
  spaces: SpaceStore["Service"],
  files: ReadonlyArray<PageRecord>,
  archived: ReadonlyArray<SpaceBindingRow>,
  active: ReadonlyArray<SpaceBindingRow>
) =>
  Effect.forEach(
    files.filter(
      (record) =>
        archived.some((holder) => bindingOwnsPath(spaceBinding(holder), record.resource.path)) &&
        !active.some(
          (holder) =>
            holder.page_path !== null && bindingOwnsPath(spaceBinding(holder), record.resource.path)
        )
    ),
    (record) => spaceOwnsWikiPath(spaces, record.resource.path)
  ).pipe(Effect.map((owned) => owned.filter(Boolean).length))

it("replays which pages each Space owns, and which Spaces get a page, on the copy", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const copy = located.copy
  const counts = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const spaces = yield* SpaceStore
      const active = yield* spaces.list()
      const archived = yield* spaces.listArchived()
      const bindings = yield* spaces.activeBindings()
      const snapshot = yield* Effect.gen(function* () {
        return yield* makeWikiListingMethods(yield* ManagedFileRepository).snapshot()
      }).pipe(
        Effect.scoped,
        Effect.provide(
          managedFileRepositoryNodeLayer({
            workingRoot: join(copy.wiki, "pages"),
            historyRoot: join(copy.wiki, ".wiki-history")
          })
        )
      )
      const live = snapshot.pages.filter(
        (record) => record.resource.state === "active" && record.page.lifecycle === "active"
      )
      const plans = active.map((space) =>
        planSpacePage(
          snapshot.pages,
          space,
          bindings.filter((binding) => binding.space_id !== space.space_id).map(spaceBinding)
        )
      )
      const files = snapshot.pages.filter((record) => record.resource.state === "active")
      const ownedBy = (holders: ReadonlyArray<SpaceBindingRow>) =>
        files.filter((record) =>
          holders.some((holder) => bindingOwnsPath(spaceBinding(holder), record.resource.path))
        ).length
      const archivedBound = archived.filter((space) => space.page_path !== null)
      const lists = active.flatMap((space) => {
        const page = live.find((record) => record.page.pageId === space.page_id)
        if (page === undefined) return []
        const ref = { pageId: page.page.pageId, pagePath: page.resource.path }
        const whole = spacePageIndex(live, ref, Number.MAX_SAFE_INTEGER)
        return [{ pages: spacePages(live, ref).length - 1, bytes: whole.bytes }]
      })
      return {
        active: active.length,
        activeWithPage: plans.filter((plan) => plan.kind === "keep").length,
        plans: {
          keep: plans.filter((plan) => plan.kind === "keep").length,
          rebind: plans.filter((plan) => plan.kind === "rebind").length,
          create: plans.filter((plan) => plan.kind === "create").length
        },
        archivedBound: archivedBound.length,
        pagesHeldByArchivedBefore: ownedBy(archivedBound),
        pagesHeldByArchivedNow: yield* heldOnlyByArchived(spaces, files, archivedBound, active),
        listBytes: lists.map((list) => list.bytes).sort((left, right) => left - right),
        listPages: lists.map((list) => list.pages).sort((left, right) => left - right)
      }
    })
  )
  process.stdout.write(`\nSpace index on the copy: ${JSON.stringify(counts)}\n`)
  expect(counts.plans.keep + counts.plans.rebind + counts.plans.create).toBe(counts.active)
  expect(counts.pagesHeldByArchivedNow).toBe(0)
})
