import type { WorkflowSourceRef } from "@arden-hq/protocol/workflows"
import { readManagedObjectDescriptor } from "../managed-output/descriptor.js"

const sourceRefKey = (source: WorkflowSourceRef): string =>
  `${source.provider}\0${source.kind}\0${source.ref}`

const MAX_MANAGED_SOURCE_REFS = 16
const MAX_ORDINARY_SOURCE_REFS = 64

export const addSourceRefs = (
  target: Map<string, WorkflowSourceRef>,
  sourceRefs: Iterable<WorkflowSourceRef>
): void => {
  for (const source of sourceRefs) {
    const key = sourceRefKey(source)
    if (target.has(key)) {
      target.set(key, source)
      continue
    }
    const managed = readManagedObjectDescriptor(source) !== undefined
    let categoryCount = 0
    for (const existing of target.values()) {
      if ((readManagedObjectDescriptor(existing) !== undefined) === managed) categoryCount += 1
    }
    const limit = managed ? MAX_MANAGED_SOURCE_REFS : MAX_ORDINARY_SOURCE_REFS
    if (categoryCount < limit) target.set(key, source)
  }
}

export const boundedSourceRefs = (
  sourceRefs: Iterable<WorkflowSourceRef>
): ReadonlyArray<WorkflowSourceRef> => {
  const bounded = new Map<string, WorkflowSourceRef>()
  addSourceRefs(bounded, sourceRefs)
  return [...bounded.values()]
}
