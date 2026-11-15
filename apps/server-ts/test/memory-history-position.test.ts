import { Effect } from "effect"
import { expect, it } from "vitest"

import { WikiEventOutbox } from "../src/persistence/automations/wiki-event-outbox.js"
import { type ReaderPosition, ReaderPositions } from "../src/persistence/reader-position.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const [A, B, C] = ["a", "b", "c"].map((letter) => letter.repeat(64)) as [string, string, string]

it("moves each reader's place only from where it stands", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const outbox = yield* WikiEventOutbox
      const { maintenance, dailySummary } = yield* ReaderPositions
      yield* outbox.wikiPublicationCursor(A)
      const publish = (previousRevision: string, revision: string) =>
        outbox.publishWikiChange({ previousRevision, revision, event: undefined })
      const published = [yield* publish(A, B), yield* publish(A, B), yield* publish(C, A)]
      const outcomes = <P>(position: ReaderPosition<P>, [a, b, c]: readonly [P, P, P]) =>
        Effect.gen(function* () {
          const started = [yield* position.start(a), yield* position.start(c)]
          const moves = [
            position.advance({ expected: a, next: b }),
            position.advance({ expected: a, next: b }),
            position.advance({ expected: c, next: a })
          ]
          const advanced = yield* Effect.forEach(moves, (move) =>
            Effect.match(move, { onFailure: (error) => error.reason, onSuccess: () => "ok" })
          )
          return { started, advanced, at: yield* position.read() }
        })
      return {
        published,
        publication: yield* outbox.wikiPublicationCursor(null),
        maintenance: yield* outcomes(maintenance, [A, B, C]),
        daily: yield* outcomes(dailySummary, ["2026-11-14", "2026-11-15", "2026-11-16"]),
        invalid: (yield* Effect.flip(
          dailySummary.advance({ expected: "2026-11-15", next: "soon" })
        )).reason
      }
    })
  )
  expect(result).toEqual({
    published: [{ queued: 0 }, null, null],
    publication: B,
    maintenance: { started: [A, A], advanced: ["ok", "ok", "moved"], at: B },
    daily: {
      started: ["2026-11-14", "2026-11-14"],
      advanced: ["ok", "ok", "moved"],
      at: "2026-11-15"
    },
    invalid: "invalid"
  })
})
