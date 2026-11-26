import { activeRunPages, type PageRecord, type Snapshot } from "../wiki/snapshot.js"
import { INDEX_PLAN, type IndexPlan } from "./index-plan.js"
import { type EmbeddingModelEntry } from "./models.js"

export const indexedPages = (snapshot: Snapshot): ReadonlyArray<PageRecord> =>
  activeRunPages(snapshot.pages).filter((record) => record.page.body.trim() !== "")

export const pageVersions = (snapshot: Snapshot): ReadonlyMap<string, string> =>
  new Map(
    indexedPages(snapshot).map((record) => [record.page.pageId, record.resource.versionId] as const)
  )
export const modelsInUse = (
  plan: IndexPlan,
  catalog: ReadonlyArray<EmbeddingModelEntry>
): ReadonlySet<string> => {
  switch (plan.kind) {
    case INDEX_PLAN.off:
    case INDEX_PLAN.unavailable:
      return new Set()
    case INDEX_PLAN.steady:
      return new Set([plan.target.modelId])
    case INDEX_PLAN.build: {
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
