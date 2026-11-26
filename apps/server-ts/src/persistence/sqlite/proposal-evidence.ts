import { SOURCE_KIND } from "@arden-hq/protocol/spaces/work"
import { type TaskSourceRecordSchema } from "../work/task-record.js"
import { sha256Hex } from "@arden-hq/std/hash"

export const sourceIdentity = (source: typeof TaskSourceRecordSchema.Type): string => {
  switch (source.kind) {
    case SOURCE_KIND.chat:
      return JSON.stringify([source.kind, source.session_id, source.turn_id])
    case SOURCE_KIND.memory:
      return JSON.stringify([source.kind, source.page_ref])
    case SOURCE_KIND.task:
      return JSON.stringify([source.kind, source.item_id])
    case SOURCE_KIND.space:
      return JSON.stringify([source.kind, source.space_id])
    case SOURCE_KIND.connection_item:
      return JSON.stringify([source.kind, source.item_id])
  }
}

export const sourceRevision = (source: typeof TaskSourceRecordSchema.Type): string =>
  JSON.stringify([sourceIdentity(source), source.revision])

export const normalized = (
  sources: ReadonlyArray<typeof TaskSourceRecordSchema.Type>,
  key: (source: typeof TaskSourceRecordSchema.Type) => string
): ReadonlyArray<string> => [...new Set(sources.map(key))].sort()

export const evidenceKey = (sources: ReadonlyArray<typeof TaskSourceRecordSchema.Type>): string =>
  sha256Hex(JSON.stringify(normalized(sources, sourceRevision)))
