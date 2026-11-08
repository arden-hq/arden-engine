import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { workError } from "./work-records.js"

export const assertItemEvidence = Effect.fn("Work.assertItemEvidence")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly spaceId: string
    readonly proposalId: string | undefined
    readonly sources: ReadonlyArray<SpaceTaskSource>
  }
) {
  const items = options.sources.flatMap((source) =>
    source.kind === "connection_item" ? [source] : []
  )
  if (items.length === 0) return
  for (const source of items) {
    if (source.revision !== source.item_id)
      return yield* workError(
        "invalid",
        "Cite a connection item with revision equal to its item_id"
      )
    const owned = yield* sql`SELECT 1 FROM connection_items WHERE item_id = ${source.item_id}
      AND state = 'routed' AND owner_space_id = ${options.spaceId}`
    if (owned.length === 0)
      return yield* workError(
        "invalid",
        "That item is not routed to this Space, so it cannot be evidence here"
      )
  }
  const taken = yield* threadTaken(sql, {
    itemIds: items.map((source) => source.item_id),
    exceptProposal: options.proposalId
  })
  if (taken)
    return yield* workError(
      "conflict",
      "This thread is already a Task, an open offer, or an offer the person skipped; do not offer it again"
    )
})

export const threadTaken = (
  sql: SqlClient.SqlClient,
  options: { readonly itemIds: ReadonlyArray<string>; readonly exceptProposal: string | undefined }
) =>
  sql`
    WITH cited_threads AS (
      SELECT DISTINCT item.source, item.account, item.thread_key FROM connection_item_threads AS item
      WHERE item.item_id IN (SELECT value FROM json_each(${JSON.stringify(options.itemIds)}))
    ), thread_items AS (
      SELECT item.item_id FROM connection_item_threads AS item
      JOIN cited_threads AS thread ON thread.source = item.source
        AND thread.account = item.account AND thread.thread_key = item.thread_key
    )
    SELECT 1 FROM task_proposals AS proposal
    WHERE proposal.proposal_id != ${options.exceptProposal ?? ""}
      AND proposal.settlement_client_id IS NOT 'item_move'
      AND (EXISTS (SELECT 1 FROM json_each(proposal.sources_json) AS cited
          WHERE json_extract(cited.value, '$.kind') = 'connection_item'
            AND json_extract(cited.value, '$.item_id') IN (SELECT item_id FROM thread_items))
        OR EXISTS (SELECT 1 FROM cited_threads AS thread
          WHERE thread.source = json_extract(proposal.signal_json, '$.source')
            AND thread.account = json_extract(proposal.signal_json, '$.account')
            AND thread.thread_key = json_extract(proposal.signal_json, '$.thread_key')))
    UNION ALL
    SELECT 1 FROM space_task_sources AS cited JOIN space_tasks AS task ON task.item_id = cited.item_id
    WHERE task.status != 'cancelled'
      AND json_extract(cited.source, '$.kind') = 'connection_item'
      AND json_extract(cited.source, '$.item_id') IN (SELECT item_id FROM thread_items)
    LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))
