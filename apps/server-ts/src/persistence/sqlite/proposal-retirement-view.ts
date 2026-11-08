import type {
  TaskProposalRetirement,
  TaskProposalRetirementEvidence
} from "@arden-hq/protocol/proposals"
import { TaskProposalRetirementSourceSchema } from "@arden-hq/protocol/effect/proposals"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { githubItemUrl } from "../connections/item-url.js"
import { decodeJson } from "./json.js"

const StoredRetirementSchema = Schema.Struct({
  reason: Schema.String,
  sources: Schema.optionalKey(Schema.Array(TaskProposalRetirementSourceSchema))
})

type StoredSource = typeof TaskProposalRetirementSourceSchema.Type

const NO_RETIREMENT: TaskProposalRetirement = { reason: "", evidence: [] }

interface Names {
  readonly chats: ReadonlyMap<string, string | null>
  readonly tasks: ReadonlyMap<string, string>
  readonly items: ReadonlyMap<string, { readonly title: string; readonly url: string | null }>
}

export const projectRetirements = Effect.fn("TaskProposal.projectRetirements")(function* (
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<{ readonly proposal_id: string; readonly retirement_json: string | null }>
) {
  const stored = new Map<string, typeof StoredRetirementSchema.Type | undefined>()
  for (const row of rows) {
    if (row.retirement_json === null) continue
    const decoded = yield* Effect.option(decodeJson(StoredRetirementSchema, row.retirement_json))
    stored.set(row.proposal_id, Option.getOrUndefined(decoded))
  }
  const sources = [...stored.values()].flatMap((receipt) => receipt?.sources ?? [])
  const names = yield* namesOf(sql, sources).pipe(
    Effect.orElseSucceed((): Names => ({ chats: new Map(), tasks: new Map(), items: new Map() }))
  )
  const result = new Map<string, TaskProposalRetirement>()
  for (const [proposalId, receipt] of stored) {
    if (receipt === undefined) {
      result.set(proposalId, NO_RETIREMENT)
      continue
    }
    const evidence = new Map<string, TaskProposalRetirementEvidence>()
    for (const source of receipt.sources ?? []) {
      const found = evidenceOf(source, names)
      if (found !== undefined) evidence.set(JSON.stringify(found), found)
    }
    result.set(proposalId, { reason: receipt.reason, evidence: [...evidence.values()] })
  }
  return result
})

const namesOf = Effect.fn("TaskProposal.retirementNames")(function* (
  sql: SqlClient.SqlClient,
  sources: ReadonlyArray<StoredSource>
): Effect.fn.Return<Names, unknown> {
  const ids = (pick: (source: StoredSource) => string | undefined) => [
    ...new Set(sources.flatMap((source) => pick(source) ?? []))
  ]
  const sessionIds = ids((source) =>
    source.kind === "chat" || source.kind === "chat_action" ? source.session_id : undefined
  )
  const taskIds = ids((source) => (source.kind === "task" ? source.item_id : undefined))
  const itemIds = ids((source) => (source.kind === "connection_item" ? source.item_id : undefined))
  const sessions =
    sessionIds.length === 0
      ? []
      : yield* sql<{
          readonly session_id: string
          readonly name: string | null
        }>`SELECT session_id, name FROM sessions WHERE session_id IN ${sql.in(sessionIds)}`
  const tasks =
    taskIds.length === 0
      ? []
      : yield* sql<{
          readonly item_id: string
          readonly text: string
        }>`SELECT item_id, text FROM space_tasks WHERE item_id IN ${sql.in(taskIds)}`
  const items =
    itemIds.length === 0
      ? []
      : yield* sql<{
          readonly item_id: string
          readonly title: string
          readonly source: string
          readonly thread_key: string
        }>`SELECT item_id, title, source, thread_key FROM connection_items
          WHERE item_id IN ${sql.in(itemIds)}`
  return {
    chats: new Map(sessions.map((row) => [row.session_id, row.name?.trim() || null])),
    tasks: new Map(tasks.map((row) => [row.item_id, row.text])),
    items: new Map(
      items.map((row) => [
        row.item_id,
        {
          title: row.title,
          url: row.source === "github" ? (githubItemUrl(row.thread_key) ?? null) : null
        }
      ])
    )
  }
})

const evidenceOf = (
  source: StoredSource,
  names: Names
): TaskProposalRetirementEvidence | undefined => {
  switch (source.kind) {
    case "chat":
    case "chat_action": {
      const label = names.chats.get(source.session_id)
      return label === undefined
        ? undefined
        : { kind: "chat", session_id: source.session_id, turn_id: source.turn_id, label }
    }
    case "memory":
      return { kind: "memory", page_ref: source.page_ref }
    case "task": {
      const label = names.tasks.get(source.item_id)
      return label === undefined ? undefined : { kind: "task", item_id: source.item_id, label }
    }
    case "connection_item": {
      const item = names.items.get(source.item_id)
      return item === undefined
        ? undefined
        : { kind: "connection_item", item_id: source.item_id, label: item.title, url: item.url }
    }
    case "space":
      return undefined
  }
}
