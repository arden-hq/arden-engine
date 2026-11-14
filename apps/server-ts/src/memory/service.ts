import { Context, DateTime, Effect, Layer, Schema } from "effect"

import { WikiEmbeddingIndex } from "../embedding/wiki-index.js"
import { MemoryCaptureStore, type MemoryCaptureBatch } from "../persistence/memory/store.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { lastChangedLines } from "../wiki/page-age.js"
import { Wiki } from "../wiki/service.js"
import type { PageTimes } from "../wiki/timestamps.js"
import { readSnapshotContent, type Snapshot } from "../wiki/snapshot.js"
import { makeMemoryCaptureBatches, MemoryError } from "./capture-batches.js"
import { startMemoryContentSteps } from "./content-steps.js"
import { citedChatRefs, discussedIn } from "./discussed-in.js"
import { prepareMemoryRecall, type MemoryRecall } from "./retrieval.js"
import { makeMemoryPreparation } from "./preparation.js"

interface MemoryRecallInput {
  readonly sessionId: string
  readonly query: string
  readonly excludePageIds?: ReadonlyArray<string>
}

export interface MemoryTurn {
  /** The Memory revision every read in this turn is made at. */
  readonly revision: string | null
  readonly readContent: (pageId: string) => ReturnType<typeof readSnapshotContent>
  readonly recall: (input: MemoryRecallInput) => Effect.Effect<MemoryRecall, MemoryError>
}

export type { MemoryCaptureBatch } from "../persistence/memory/store.js"

export class Memory extends Context.Service<
  Memory,
  {
    readonly prepare: () => Effect.Effect<void>
    readonly withTurn: <A, E, R>(
      consume: (turn: MemoryTurn | undefined) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>
    readonly nextCaptureBatch: () => Effect.Effect<MemoryCaptureBatch | null, MemoryError>
    readonly completeCaptureBatch: (batch: MemoryCaptureBatch) => Effect.Effect<void, MemoryError>
  }
>()("@arden-hq/server/memory/Memory") {
  static layer(): Layer.Layer<
    Memory,
    never,
    Wiki | WikiEmbeddingIndex | MemoryCaptureStore | SessionQueries | TranscriptQueries | SpaceStore
  > {
    return Layer.effect(
      Memory,
      Effect.gen(function* () {
        const wiki = yield* Wiki
        const captures = yield* MemoryCaptureStore
        const sessions = yield* SessionQueries
        const spaces = yield* SpaceStore
        const transcript = yield* TranscriptQueries
        const embeddings = yield* WikiEmbeddingIndex

        yield* startMemoryContentSteps({ wiki, sessions, transcript })

        const snapshot = Effect.fn("Memory.snapshot")(function* () {
          const observed = yield* wiki.observe()
          const loaded = yield* wiki.snapshot()
          return loaded.head === observed ? loaded : yield* wiki.snapshot()
        })

        const preparation = yield* makeMemoryPreparation({ wiki })

        const recall = Effect.fn("Memory.recall")(function* (
          input: MemoryRecallInput,
          current: Snapshot
        ) {
          const valid = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              sessionId: Schema.NonEmptyString,
              query: Schema.String,
              excludePageIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
            })
          )(input).pipe(
            Effect.mapError(
              (cause) =>
                new MemoryError({
                  operation: "recall",
                  message: "Invalid Memory recall request",
                  sessionId: input.sessionId,
                  cause
                })
            )
          )
          const excludedPageIds = new Set(valid.excludePageIds ?? [])
          const semantic = yield* embeddings
            .search(current, valid.query, excludedPageIds)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Semantic Memory recall failed", cause).pipe(Effect.as([]))
              )
            )
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          const times = yield* wiki
            .pageTimes(current.head)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Memory page times unavailable", cause).pipe(
                  Effect.as(new Map<string, PageTimes>())
                )
              )
            )
          const prepared = prepareMemoryRecall({
            lastChanged: lastChangedLines(times, now),
            pages: current.pages,
            query: valid.query,
            semanticMatches: semantic,
            excludedPageIds
          })
          const chats = yield* discussedIn({
            wiki,
            sessions,
            spaceName: (spaceId) => spaces.get(spaceId).pipe(Effect.map((space) => space?.name)),
            sessionId: valid.sessionId,
            cited: new Map(
              prepared.pages.map(
                (record) => [record.page.pageId, citedChatRefs(record.page.body)] as const
              )
            )
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Memory page chats unavailable", cause).pipe(Effect.as(new Map()))
            )
          )
          return prepared.render(chats)
        })

        const withTurn = Effect.fn("Memory.withTurn")(function* <A, E, R>(
          consume: (turn: MemoryTurn | undefined) => Effect.Effect<A, E, R>
        ): Effect.fn.Return<A, E, R> {
          const current = yield* snapshot().pipe(
            Effect.catchTag("WikiError", (cause) =>
              Effect.logWarning("Memory snapshot unavailable", { cause }).pipe(Effect.as(undefined))
            )
          )
          return yield* consume(
            current === undefined
              ? undefined
              : {
                  revision: current.head,
                  readContent: (pageId) => readSnapshotContent(current, pageId),
                  recall: (input) => recall(input, current)
                }
          )
        }, preparation.foreground)

        const captureBatches = makeMemoryCaptureBatches({
          wiki,
          snapshot,
          captures,
          sessions,
          transcript
        })

        yield* preparation.schedule()
        return Memory.of({
          prepare: preparation.schedule,
          withTurn,
          nextCaptureBatch: captureBatches.nextCaptureBatch,
          completeCaptureBatch: captureBatches.completeCaptureBatch
        })
      })
    )
  }
}
