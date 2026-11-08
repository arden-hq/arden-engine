import type { EmbeddingIndexStatus } from "@arden-hq/protocol/embeddings"
import { Clock, Context, DateTime, Effect, Layer, Queue, Ref, Schema, Semaphore } from "effect"

import {
  WikiEmbeddingStore,
  type StoredWikiEmbeddingChunk,
  type WikiEmbeddingPageWrite
} from "../persistence/memory/embedding-store.js"
import { EmbeddingSettingsStore } from "../persistence/settings/store.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { Wiki } from "../wiki/service.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import {
  applyControl,
  coveredPages,
  etaSeconds,
  indexStatus,
  planIndex,
  searchSource,
  type EmbeddingControl,
  type IndexPlan,
  type RunSample
} from "./index-plan.js"
import type { EmbeddingModel } from "./model.js"
import { EmbeddingModels, type EmbeddingModelEntry } from "./models.js"

const MIN_QUERY_LENGTH = 12
const SEARCH_LIMIT = 8

export interface SemanticMemoryMatch {
  readonly pageId: string
  readonly chunkText: string
  readonly score: number
}

export class WikiEmbeddingIndexError extends Schema.TaggedError<WikiEmbeddingIndexError>()(
  "WikiEmbeddingIndexError",
  {
    operation: Schema.Literals(["index", "search", "status", "control"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class EmbeddingControlRejected extends Schema.TaggedError<EmbeddingControlRejected>()(
  "EmbeddingControlRejected",
  { reason: Schema.Literals(["unknown_model", "no_previous"] as const) }
) {}

export class WikiEmbeddingIndex extends Context.Service<
  WikiEmbeddingIndex,
  {
    readonly schedule: (snapshot: Snapshot) => Effect.Effect<void>
    readonly status: () => Effect.Effect<EmbeddingIndexStatus, WikiEmbeddingIndexError>
    readonly control: (
      control: EmbeddingControl
    ) => Effect.Effect<EmbeddingIndexStatus, WikiEmbeddingIndexError | EmbeddingControlRejected>
    readonly search: (
      snapshot: Snapshot,
      query: string,
      excludedPageIds?: ReadonlySet<string>
    ) => Effect.Effect<ReadonlyArray<SemanticMemoryMatch>, WikiEmbeddingIndexError>
  }
>()("@arden-hq/server/embedding/WikiEmbeddingIndex") {}

const indexError = (
  operation: WikiEmbeddingIndexError["operation"],
  message: string,
  cause: unknown
) => new WikiEmbeddingIndexError({ operation, message, cause })

const indexedPages = (snapshot: Snapshot): ReadonlyArray<PageRecord> =>
  snapshot.pages.filter(
    (record) =>
      record.page.lifecycle === "active" &&
      record.page.pageId !== "health" &&
      record.page.body.trim() !== ""
  )

const pageVersions = (snapshot: Snapshot): ReadonlyMap<string, string> =>
  new Map(
    indexedPages(snapshot).map((record) => [record.page.pageId, record.resource.versionId] as const)
  )

const bytes = (embedding: Float32Array): Uint8Array =>
  Uint8Array.from(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength))

const vector = (chunk: StoredWikiEmbeddingChunk): Float32Array => {
  const copied = Uint8Array.from(chunk.embedding)
  return new Float32Array(copied.buffer, copied.byteOffset, copied.byteLength / 4)
}

const similarity = (left: Float32Array, right: Float32Array): number => {
  let score = 0
  for (const [index, value] of left.entries()) {
    const other = right[index]
    if (other !== undefined) score += value * other
  }
  return score
}

const rankSemanticMatches = (
  matches: ReadonlyArray<SemanticMemoryMatch>,
  excludedPageIds: ReadonlySet<string> = new Set()
): ReadonlyArray<SemanticMemoryMatch> =>
  matches
    .filter((match) => !excludedPageIds.has(match.pageId))
    .sort((left, right) => right.score - left.score || left.pageId.localeCompare(right.pageId))
    .slice(0, SEARCH_LIMIT)

const modelsInUse = (
  plan: IndexPlan,
  catalog: ReadonlyArray<EmbeddingModelEntry>
): ReadonlySet<string> => {
  switch (plan.kind) {
    case "off":
    case "unavailable":
      return new Set()
    case "steady":
      return new Set([plan.target.modelId])
    case "build": {
      const serving = plan.serving
      const servingUsable =
        serving !== undefined &&
        catalog.some(
          (entry) =>
            entry.modelId === serving.modelId && entry.indexVersion === serving.indexVersion
        )
      return new Set(servingUsable ? [plan.target.modelId, serving.modelId] : [plan.target.modelId])
    }
  }
}

const make = Effect.fn("WikiEmbeddingIndex.make")(function* () {
  const models = yield* EmbeddingModels
  const store = yield* WikiEmbeddingStore
  const settingsStore = yield* EmbeddingSettingsStore
  const wiki = yield* Wiki
  const lifecycle = yield* ServerLifecycle
  const queue = yield* Effect.acquireRelease(Queue.sliding<Snapshot>(1), Queue.shutdown)
  const lastError = yield* Ref.make<string | undefined>(undefined)
  const sample = yield* Ref.make<RunSample | undefined>(undefined)
  const loadingModel = yield* Ref.make(false)
  const controls = yield* Ref.make(0)
  const controlLock = yield* Semaphore.make(1)

  const readState = Effect.fn("WikiEmbeddingIndex.readState")(function* (
    operation: WikiEmbeddingIndexError["operation"]
  ) {
    const settings = yield* settingsStore
      .settings()
      .pipe(
        Effect.mapError((cause) =>
          indexError(operation, "Could not read embedding settings", cause)
        )
      )
    const catalog = yield* models.catalog()
    const indexes = yield* store
      .indexes()
      .pipe(
        Effect.mapError((cause) => indexError(operation, "Could not read the Wiki index", cause))
      )
    return { settings, catalog, indexes }
  })

  const reconcile = Effect.fn("WikiEmbeddingIndex.reconcile")(function* (
    model: EmbeddingModel["Service"],
    indexVersion: string,
    snapshot: Snapshot,
    generation: number
  ) {
    const pages = indexedPages(snapshot)
    const activeIds = new Set(pages.map((record) => record.page.pageId))
    const states = yield* store
      .pages(indexVersion)
      .pipe(Effect.mapError((cause) => indexError("index", "Could not read the Wiki index", cause)))
    yield* store
      .deletePages(
        indexVersion,
        states.filter((state) => !activeIds.has(state.pageId)).map((state) => state.pageId)
      )
      .pipe(
        Effect.mapError((cause) => indexError("index", "Could not prune the Wiki index", cause))
      )
    const current = new Map(states.map((state) => [state.pageId, state.pageVersion] as const))

    for (const record of pages) {
      if (current.get(record.page.pageId) === record.resource.versionId) continue
      if ((yield* Ref.get(controls)) !== generation) return false
      const chunks = yield* model
        .chunkDocument({
          title: record.page.title,
          path: record.resource.path,
          body: record.page.body
        })
        .pipe(Effect.mapError((cause) => indexError("index", "Could not chunk a Wiki page", cause)))
      const writes: Array<WikiEmbeddingPageWrite["chunks"][number]> = []
      for (let offset = 0; offset < chunks.length; offset += model.batchSize) {
        const batch = chunks.slice(offset, offset + model.batchSize)
        const embeddings = yield* model
          .embed(batch.map((chunk) => chunk.text))
          .pipe(
            Effect.mapError((cause) => indexError("index", "Could not embed a Wiki page", cause))
          )
        for (const [index, chunk] of batch.entries()) {
          const embedding = embeddings[index]
          if (embedding === undefined) {
            return yield* indexError("index", "The embedding model skipped a Wiki chunk", undefined)
          }
          writes.push({
            chunkIndex: offset + index,
            chunkText: chunk.excerpt,
            embedding: bytes(embedding)
          })
        }
      }
      yield* store
        .replacePage({
          indexVersion,
          pageId: record.page.pageId,
          pageVersion: record.resource.versionId,
          chunks: writes
        })
        .pipe(
          Effect.mapError((cause) => indexError("index", "Could not store Wiki embeddings", cause))
        )
    }
    return true
  })

  const reconcileWith = (
    modelId: string,
    indexVersion: string,
    snapshot: Snapshot,
    generation: number,
    building = false
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const loadStart = yield* Clock.currentTimeMillis
        if (building) yield* Ref.set(loadingModel, true)
        const model = yield* models.use(modelId).pipe(
          Effect.mapError((cause) =>
            indexError("index", "The embedding model did not load", cause)
          ),
          Effect.ensuring(Ref.set(loadingModel, false))
        )
        const loadMs = (yield* Clock.currentTimeMillis) - loadStart
        const before = building ? yield* Ref.get(sample) : undefined
        const finished = yield* reconcile(model, indexVersion, snapshot, generation)
        if (before !== undefined && finished) {
          const runMs = Math.max(1, (yield* Clock.currentTimeMillis) - loadStart - loadMs)
          const covered = coveredPages(
            pageVersions(snapshot),
            yield* store
              .pages(indexVersion)
              .pipe(
                Effect.mapError((cause) =>
                  indexError("index", "Could not read the Wiki index", cause)
                )
              )
          )
          const pages = covered - before.startPages
          if (pages > 0)
            yield* Effect.logInfo("Wiki embedding run", {
              model: modelId,
              modelLoadMs: loadMs,
              pages,
              pagesPerSecond: Math.round((pages * 10_000) / runMs) / 10
            })
        }
        return finished
      })
    )

  const step = Effect.fn("WikiEmbeddingIndex.step")(function* (snapshot: Snapshot) {
    const generation = yield* Ref.get(controls)
    const { settings, catalog, indexes } = yield* readState("index")
    const plan = planIndex({ settings, indexes, catalog })
    yield* Effect.forEach(plan.drop, (indexVersion) => store.drop(indexVersion), {
      discard: true
    }).pipe(Effect.mapError((cause) => indexError("index", "Could not delete a Wiki index", cause)))
    const inUse = modelsInUse(plan, catalog)
    yield* Effect.forEach(
      catalog.filter((entry) => !inUse.has(entry.modelId)),
      (entry) => models.release(entry.modelId),
      { discard: true }
    )
    switch (plan.kind) {
      case "off":
      case "unavailable":
        yield* Ref.set(sample, undefined)
        return
      case "steady":
        yield* Ref.set(sample, undefined)
        yield* reconcileWith(plan.target.modelId, plan.target.indexVersion, snapshot, generation)
        return
      case "build": {
        const serving = plan.serving
        if (
          serving !== undefined &&
          inUse.has(serving.modelId) &&
          serving.modelId !== plan.target.modelId
        )
          yield* reconcileWith(serving.modelId, serving.indexVersion, snapshot, generation)
        if (settings.paused) {
          yield* Ref.set(sample, undefined)
          return
        }
        const target = plan.target
        if (!indexes.some((index) => index.indexVersion === target.indexVersion)) {
          const startedAt = DateTime.formatIso(yield* DateTime.now)
          yield* store
            .openBuilding({ ...target, startedAt })
            .pipe(
              Effect.mapError((cause) => indexError("index", "Could not start a Wiki index", cause))
            )
        }
        const versions = pageVersions(snapshot)
        if ((yield* Ref.get(sample)) === undefined) {
          const covered = coveredPages(
            versions,
            yield* store
              .pages(target.indexVersion)
              .pipe(
                Effect.mapError((cause) =>
                  indexError("index", "Could not read the Wiki index", cause)
                )
              )
          )
          yield* Ref.set(sample, {
            startedAtMs: yield* Clock.currentTimeMillis,
            startPages: covered
          })
        }
        const finished = yield* reconcileWith(
          target.modelId,
          target.indexVersion,
          snapshot,
          generation,
          true
        )
        if (!finished || (yield* Ref.get(controls)) !== generation) return
        yield* store
          .promote(target.indexVersion)
          .pipe(
            Effect.mapError((cause) =>
              indexError("index", "Could not switch the Wiki index", cause)
            )
          )
        yield* Ref.set(sample, undefined)
        if (serving !== undefined && serving.modelId !== target.modelId)
          yield* models.release(serving.modelId)
        yield* Effect.logInfo("Wiki embedding index switched", { model: target.modelId })
      }
    }
  })

  const schedule = (snapshot: Snapshot): Effect.Effect<void> =>
    Queue.offer(queue, snapshot).pipe(Effect.asVoid)

  const status = Effect.fn("WikiEmbeddingIndex.status")(function* () {
    const snapshot = yield* wiki
      .snapshot()
      .pipe(Effect.mapError((cause) => indexError("status", "Could not read the Wiki", cause)))
    const { settings, catalog, indexes } = yield* readState("status")
    const plan = planIndex({ settings, indexes, catalog })
    const versions = pageVersions(snapshot)
    const target = plan.kind === "steady" || plan.kind === "build" ? plan.target : undefined
    const stored =
      target === undefined || !indexes.some((index) => index.indexVersion === target.indexVersion)
        ? []
        : yield* store
            .pages(target.indexVersion)
            .pipe(
              Effect.mapError((cause) =>
                indexError("status", "Could not read the Wiki index", cause)
              )
            )
    const covered = coveredPages(versions, stored)
    return indexStatus({
      plan,
      paused: settings.paused,
      catalog,
      indexes,
      building: indexes.find(
        (index) => index.role === "building" && index.indexVersion === target?.indexVersion
      ),
      indexedPages: covered,
      totalPages: versions.size,
      error: yield* Ref.get(lastError),
      eta: etaSeconds({
        sample: yield* Ref.get(sample),
        nowMs: yield* Clock.currentTimeMillis,
        indexedPages: covered,
        totalPages: versions.size
      }),
      loading: yield* Ref.get(loadingModel),
      now: DateTime.formatIso(yield* DateTime.now),
      sizes: yield* store
        .sizes()
        .pipe(
          Effect.mapError((cause) =>
            indexError("status", "Could not measure the Wiki index", cause)
          )
        )
    })
  })

  const control = Effect.fn("WikiEmbeddingIndex.control")(function* (request: EmbeddingControl) {
    yield* controlLock.withPermit(
      Effect.gen(function* () {
        const { settings, catalog, indexes } = yield* readState("control")
        const result = applyControl({ settings, indexes, catalog, control: request })
        if (result.kind === "rejected")
          return yield* new EmbeddingControlRejected({ reason: result.reason })
        yield* settingsStore
          .updateSettings(result.settings)
          .pipe(
            Effect.mapError((cause) =>
              indexError("control", "Could not save embedding settings", cause)
            )
          )
        yield* Ref.update(controls, (generation) => generation + 1)
        if (request.kind !== "pause") yield* Ref.set(lastError, undefined)
        if (request.kind !== "pause") yield* Ref.set(sample, undefined)
      })
    )
    const snapshot = yield* wiki
      .snapshot()
      .pipe(Effect.mapError((cause) => indexError("control", "Could not read the Wiki", cause)))
    yield* schedule(snapshot)
    return yield* status().pipe(
      Effect.mapError((cause) => indexError("control", cause.message, cause))
    )
  })

  const search = Effect.fn("WikiEmbeddingIndex.search")(function* (
    snapshot: Snapshot,
    query: string,
    excludedPageIds: ReadonlySet<string> = new Set()
  ) {
    yield* schedule(snapshot)
    const text = query.trim()
    if (text.length < MIN_QUERY_LENGTH) return []
    const { settings, catalog, indexes } = yield* readState("search")
    const source = searchSource({ modelId: settings.modelId, indexes, catalog })
    if (source === undefined) return []
    const queryVector = yield* Effect.scoped(
      models.use(source.modelId).pipe(
        Effect.flatMap((model) => model.embed([text])),
        Effect.mapError((cause) => indexError("search", "Could not embed the Memory query", cause))
      )
    ).pipe(Effect.map((embedded) => embedded[0]))
    if (queryVector === undefined) {
      return yield* indexError(
        "search",
        "The embedding model returned no vector for the Memory query",
        undefined
      )
    }
    const chunks = yield* store
      .list(source.indexVersion)
      .pipe(
        Effect.mapError((cause) => indexError("search", "Could not read Wiki embeddings", cause))
      )
    const versions = pageVersions(snapshot)
    const best = new Map<string, SemanticMemoryMatch>()
    for (const chunk of chunks) {
      if (versions.get(chunk.pageId) !== chunk.pageVersion) continue
      const score = similarity(queryVector, vector(chunk))
      const previous = best.get(chunk.pageId)
      if (Number.isFinite(score) && (previous === undefined || score > previous.score)) {
        best.set(chunk.pageId, { pageId: chunk.pageId, chunkText: chunk.chunkText, score })
      }
    }
    return rankSemanticMatches([...best.values()], excludedPageIds)
  })

  yield* lifecycle.background(
    Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((snapshot) =>
          step(snapshot).pipe(
            Effect.tap(() => Ref.set(lastError, undefined)),
            Effect.catch((cause) =>
              Ref.set(lastError, cause.message).pipe(
                Effect.andThen(Effect.logWarning("Wiki embedding refresh failed", cause))
              )
            )
          )
        )
      )
    )
  )
  yield* lifecycle.background(
    wiki.snapshot().pipe(
      Effect.flatMap(schedule),
      Effect.catchCause((cause) =>
        Effect.logWarning("Initial Wiki embedding refresh failed", cause)
      )
    )
  )

  return WikiEmbeddingIndex.of({ schedule, status, control, search })
})

export const wikiEmbeddingIndexLayer: Layer.Layer<
  WikiEmbeddingIndex,
  never,
  EmbeddingModels | WikiEmbeddingStore | EmbeddingSettingsStore | Wiki
> = Layer.effect(WikiEmbeddingIndex, make())
