import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { wikiOriginChat } from "../src/wiki/commit.js"
import { makeWikiHistoryMethods } from "../src/wiki/history.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { activeRunPages } from "../src/wiki/snapshot.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"

const located = locateReplayCopy()

const SAMPLED_PAGES = 44
const LINES_PER_PAGE = 4
const MIN_LINE_CHARS = 20

it("traces sampled lines of the copy's pages to the change that added them, by counts", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const copy = located.copy
  const counts = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const traced = yield* Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const listing = makeWikiListingMethods(repository)
        const history = makeWikiHistoryMethods(repository, listing.snapshot)
        const pages = activeRunPages((yield* listing.snapshot()).pages).toSorted((left, right) =>
          left.resource.path.localeCompare(right.resource.path)
        )
        const stride = Math.max(1, Math.floor(pages.length / SAMPLED_PAGES))
        const sampled = pages.filter((_, index) => index % stride === 0).slice(0, SAMPLED_PAGES)
        return yield* Effect.forEach(sampled, (record) =>
          Effect.forEach(
            [
              ...new Set(
                record.page.body
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length >= MIN_LINE_CHARS && !line.startsWith("#"))
              )
            ].slice(0, LINES_PER_PAGE),
            (line) => history.lineOrigin(record.page.pageId, line)
          )
        ).pipe(Effect.map((perPage) => ({ pages: sampled.length, origins: perPage.flat() })))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          managedFileRepositoryNodeLayer({
            workingRoot: join(copy.wiki, "pages"),
            historyRoot: join(copy.wiki, ".wiki-history")
          })
        )
      )
      const added = traced.origins.flatMap((origin) => (origin.kind === "added" ? [origin] : []))
      const chats = added.flatMap((origin) => {
        const chat = wikiOriginChat(origin.origin)
        return chat === undefined ? [] : [chat]
      })
      const existing = yield* Effect.forEach(chats, (sessionId) =>
        sql<{ readonly found: number }>`
          SELECT COUNT(*) AS found FROM sessions WHERE session_id = ${sessionId}`.pipe(
          Effect.map((rows) => (rows[0]?.found ?? 0) > 0)
        )
      )
      const byWriter = new Map<string, number>()
      for (const origin of added)
        byWriter.set(origin.origin.kind, (byWriter.get(origin.origin.kind) ?? 0) + 1)
      return {
        pages: traced.pages,
        lines: traced.origins.length,
        added: added.length,
        older: traced.origins.filter((origin) => origin.kind === "older").length,
        ambiguous: traced.origins.filter((origin) => origin.kind === "ambiguous").length,
        absent: traced.origins.filter((origin) => origin.kind === "absent").length,
        namingAChat: chats.length,
        chatStillThere: existing.filter(Boolean).length,
        byWriter: Object.fromEntries(
          [...byWriter].toSorted(([left], [right]) => left.localeCompare(right))
        )
      }
    })
  )
  process.stdout.write(`\nLine origin on the copy: ${JSON.stringify(counts)}\n`)
  expect(counts.lines).toBeGreaterThan(0)
  expect(counts.absent).toBe(0)
  expect(counts.added + counts.older + counts.ambiguous).toBe(counts.lines)
  expect(counts.chatStillThere).toBeLessThanOrEqual(counts.namingAChat)
})
