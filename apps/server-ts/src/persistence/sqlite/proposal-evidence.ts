import type { SpaceTaskSourceSchema } from "@arden-hq/protocol/effect/spaces/work"
import { sha256Hex } from "@arden-hq/std/hash"

export const sourceIdentity = (source: typeof SpaceTaskSourceSchema.Type): string => {
  switch (source.kind) {
    case "chat":
      return JSON.stringify([source.kind, source.session_id, source.turn_id])
    case "memory":
      return JSON.stringify([source.kind, source.page_ref])
    case "task":
      return JSON.stringify([source.kind, source.item_id])
    case "space":
      return JSON.stringify([source.kind, source.space_id])
    case "connection_item":
      return JSON.stringify([source.kind, source.item_id])
  }
}

export const sourceRevision = (source: typeof SpaceTaskSourceSchema.Type): string =>
  JSON.stringify([sourceIdentity(source), source.revision])

export const normalized = (
  sources: ReadonlyArray<typeof SpaceTaskSourceSchema.Type>,
  key: (source: typeof SpaceTaskSourceSchema.Type) => string
): ReadonlyArray<string> => [...new Set(sources.map(key))].sort()

export const evidenceKey = (sources: ReadonlyArray<typeof SpaceTaskSourceSchema.Type>): string =>
  sha256Hex(JSON.stringify(normalized(sources, sourceRevision)))
