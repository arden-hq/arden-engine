import type { EmbeddingIndexStatus } from "@arden-hq/protocol/embeddings"

import type { WikiEmbeddingIndexRecord } from "../persistence/memory/embedding-store.js"
import type { EmbeddingSettings } from "../persistence/settings/store.js"
import type { EmbeddingModelEntry } from "./models.js"

export type IndexPlan =
  | { readonly kind: "off"; readonly drop: ReadonlyArray<string> }
  | { readonly kind: "unavailable"; readonly modelId: string; readonly drop: ReadonlyArray<string> }
  | {
      readonly kind: "steady"
      readonly target: EmbeddingModelEntry
      readonly drop: ReadonlyArray<string>
    }
  | {
      readonly kind: "build"
      readonly target: EmbeddingModelEntry
      readonly serving: WikiEmbeddingIndexRecord | undefined
      readonly drop: ReadonlyArray<string>
    }

export const planIndex = ({
  settings,
  indexes,
  catalog
}: {
  readonly settings: Pick<EmbeddingSettings, "modelId" | "keepIndex">
  readonly indexes: ReadonlyArray<WikiEmbeddingIndexRecord>
  readonly catalog: ReadonlyArray<EmbeddingModelEntry>
}): IndexPlan => {
  const modelId = settings.modelId
  if (modelId === null)
    return {
      kind: "off",
      drop: settings.keepIndex ? [] : indexes.map((index) => index.indexVersion)
    }
  const target = catalog.find((entry) => entry.modelId === modelId)
  const serving = indexes.find((index) => index.role === "serving")
  const building = indexes.filter((index) => index.role === "building")
  if (target === undefined)
    return { kind: "unavailable", modelId, drop: building.map((index) => index.indexVersion) }
  if (serving?.indexVersion === target.indexVersion)
    return { kind: "steady", target, drop: building.map((index) => index.indexVersion) }
  return {
    kind: "build",
    target,
    serving,
    drop: building
      .filter((index) => index.indexVersion !== target.indexVersion)
      .map((index) => index.indexVersion)
  }
}

export interface SearchSource {
  readonly indexVersion: string
  readonly modelId: string
}

export const searchSource = ({
  modelId,
  indexes,
  catalog
}: {
  readonly modelId: string | null
  readonly indexes: ReadonlyArray<WikiEmbeddingIndexRecord>
  readonly catalog: ReadonlyArray<EmbeddingModelEntry>
}): SearchSource | undefined => {
  if (modelId === null) return undefined
  const usable = (role: WikiEmbeddingIndexRecord["role"]) =>
    indexes.find(
      (index) =>
        index.role === role &&
        catalog.some(
          (entry) => entry.modelId === index.modelId && entry.indexVersion === index.indexVersion
        )
    )
  const index = usable("serving") ?? usable("building")
  return index === undefined
    ? undefined
    : { indexVersion: index.indexVersion, modelId: index.modelId }
}

export type EmbeddingControl =
  | { readonly kind: "choose"; readonly modelId: string }
  | { readonly kind: "off"; readonly keepIndex: boolean }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "cancel" }

type EmbeddingControlRejection = "unknown_model" | "no_previous"

export type EmbeddingControlResult =
  | { readonly kind: "apply"; readonly settings: EmbeddingSettings }
  | { readonly kind: "rejected"; readonly reason: EmbeddingControlRejection }

export const applyControl = ({
  settings,
  indexes,
  catalog,
  control
}: {
  readonly settings: EmbeddingSettings
  readonly indexes: ReadonlyArray<WikiEmbeddingIndexRecord>
  readonly catalog: ReadonlyArray<EmbeddingModelEntry>
  readonly control: EmbeddingControl
}): EmbeddingControlResult => {
  const plan = planIndex({ settings, indexes, catalog })
  switch (control.kind) {
    case "choose":
      if (!catalog.some((entry) => entry.modelId === control.modelId))
        return { kind: "rejected", reason: "unknown_model" }
      return {
        kind: "apply",
        settings: { modelId: control.modelId, keepIndex: false, paused: false }
      }
    case "off":
      return {
        kind: "apply",
        settings: { modelId: null, keepIndex: control.keepIndex, paused: false }
      }
    case "pause":
      return { kind: "apply", settings: { ...settings, paused: plan.kind === "build" } }
    case "resume":
      return { kind: "apply", settings: { ...settings, paused: false } }
    case "cancel": {
      if (plan.kind !== "build") return { kind: "apply", settings }
      if (plan.serving === undefined)
        return { kind: "apply", settings: { modelId: null, keepIndex: false, paused: false } }
      const previous = searchSource({ modelId: plan.serving.modelId, indexes, catalog })
      if (previous?.indexVersion !== plan.serving.indexVersion)
        return { kind: "rejected", reason: "no_previous" }
      return {
        kind: "apply",
        settings: { modelId: plan.serving.modelId, keepIndex: false, paused: false }
      }
    }
  }
}

export const coveredPages = (
  current: ReadonlyMap<string, string>,
  stored: ReadonlyArray<{ readonly pageId: string; readonly pageVersion: string }>
): number => stored.filter((page) => current.get(page.pageId) === page.pageVersion).length

const ETA_MIN_PAGES = 3

export interface RunSample {
  readonly startedAtMs: number
  readonly startPages: number
}

export const etaSeconds = ({
  sample,
  nowMs,
  indexedPages,
  totalPages
}: {
  readonly sample: RunSample | undefined
  readonly nowMs: number
  readonly indexedPages: number
  readonly totalPages: number
}): number | undefined => {
  if (sample === undefined) return undefined
  const done = indexedPages - sample.startPages
  if (done < ETA_MIN_PAGES) return undefined
  const perPageMs = Math.max(0, nowMs - sample.startedAtMs) / done
  return Math.ceil((perPageMs * Math.max(0, totalPages - indexedPages)) / 1000)
}

export const indexStatus = ({
  plan,
  paused,
  catalog,
  indexes,
  building,
  indexedPages,
  totalPages,
  error,
  eta,
  loading = false,
  now,
  sizes
}: {
  readonly plan: IndexPlan
  readonly paused: boolean
  readonly catalog: ReadonlyArray<EmbeddingModelEntry>
  readonly indexes: ReadonlyArray<WikiEmbeddingIndexRecord>
  readonly building: WikiEmbeddingIndexRecord | undefined
  readonly indexedPages: number
  readonly totalPages: number
  readonly error: string | undefined
  readonly eta: number | undefined
  readonly loading?: boolean
  readonly now: string
  readonly sizes: ReadonlyMap<string, number>
}): EmbeddingIndexStatus => {
  const stored = indexes.map((index) => ({
    modelId: index.modelId,
    role: index.role,
    bytes: sizes.get(index.indexVersion) ?? 0
  }))
  const models = catalog.map((entry) => ({ modelId: entry.modelId, dimensions: entry.dimensions }))
  const pages = { indexedPages: Math.min(indexedPages, totalPages), totalPages }
  const usable = (index: WikiEmbeddingIndexRecord | undefined) =>
    index !== undefined &&
    catalog.some(
      (entry) => entry.modelId === index.modelId && entry.indexVersion === index.indexVersion
    )
      ? index
      : undefined
  switch (plan.kind) {
    case "off": {
      const kept =
        plan.drop.length === 0
          ? usable(indexes.find((index) => index.role === "serving"))
          : undefined
      return {
        state: "idle",
        keptModelId: kept?.modelId ?? null,
        unavailableModelId: null,
        models,
        indexes: stored
      }
    }
    case "unavailable":
      return {
        state: "idle",
        keptModelId: null,
        unavailableModelId: plan.modelId,
        models,
        indexes: stored
      }
    case "steady":
      return error === undefined
        ? { state: "done", modelId: plan.target.modelId, ...pages, models, indexes: stored }
        : {
            state: "failed",
            modelId: plan.target.modelId,
            previousModelId: null,
            ...pages,
            error,
            models,
            indexes: stored
          }
    case "build": {
      const job = {
        modelId: plan.target.modelId,
        previousModelId: usable(plan.serving)?.modelId ?? null,
        ...pages,
        models,
        indexes: stored
      }
      if (paused)
        return {
          state: "paused",
          ...job,
          startedAt: building?.startedAt ?? now,
          phase: "pages",
          etaSeconds: null
        }
      if (error !== undefined) return { state: "failed", ...job, error }
      return {
        state: "indexing",
        ...job,
        startedAt: building?.startedAt ?? now,
        phase: loading ? "loading" : "pages",
        etaSeconds: eta ?? null
      }
    }
  }
}
