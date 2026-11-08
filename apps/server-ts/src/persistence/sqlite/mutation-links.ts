import { Effect } from "effect"
import { Statement, type SqlClient } from "effect/unstable/sql"
import type { ChangeEntry, ChangeEvidence } from "@arden-hq/protocol/chat"
import { mutationOperationId, type MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { outToolStatusList } from "./status-sets.js"
import { runDescendants } from "./tree-walk.js"

const owners = {
  task: { history: "space_task_revisions", links: "space_task_mutation_links", key: "item_id" },
  proposal: {
    history: "task_proposal_revisions",
    links: "task_proposal_mutation_links",
    key: "proposal_id"
  },
  space: { history: "space_revisions", links: "space_mutation_links", key: "space_id" },
  session: { history: "session_revisions", links: "session_mutation_links", key: "session_id" },
  automation: {
    history: "automation_configuration_revisions",
    links: "automation_configuration_mutation_links",
    key: "task_id"
  }
} as const

export const captureMutationVersions = Effect.fn("MutationLinks.capture")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly domain: keyof typeof owners
    readonly id: string
    readonly identity: MutationOperationIdentity | undefined
  }
) {
  if (input.identity === undefined) return Effect.void
  const identity = input.identity
  const calls = yield* sql`SELECT 1 FROM tool_calls
    WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
      AND changes_state = 1 AND status IN ${outToolStatusList}`
  if (calls.length !== 1) return Effect.void
  const owner = owners[input.domain]
  const table = sql.literal(owner.history)
  const links = sql.literal(owner.links)
  const key = sql.literal(owner.key)
  const [head] = yield* sql<{ readonly version: number }>`
    SELECT COALESCE(MAX(version), 0) AS version FROM ${table} WHERE ${key} = ${input.id}`
  return sql`INSERT INTO ${links} (${key}, version, run_id, tool_call_id)
    SELECT ${key}, version, ${identity.runId}, ${identity.toolCallId} FROM ${table}
    WHERE ${key} = ${input.id} AND version > ${head?.version ?? 0} AND kind <> 'baseline'`.pipe(
    Effect.asVoid
  )
})

type MutationVersions = {
  readonly entries: ReadonlyArray<ChangeEntry>
  readonly omitted: number
}

const VERSIONS_MAX = 100

export const readMutationVersions = Effect.fn("MutationLinks.read")(function* (
  sql: SqlClient.SqlClient,
  identity: MutationOperationIdentity
) {
  const read = yield* readMutationVersionsOf(sql, identity.runId, [identity.toolCallId])
  return read.get(identity.toolCallId) ?? { entries: [], omitted: 0 }
})

export const readMutationVersionsOf = Effect.fn("MutationLinks.readMany")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>
) {
  const read = new Map<string, MutationVersions>()
  if (toolCallIds.length === 0) return read
  const selects = Object.entries(owners).map(
    ([domain, owner]) => sql`
    SELECT ${domain} AS domain, links.${sql.literal(owner.key)} AS resource_id,
      links.version, history.kind, links.tool_call_id
    FROM ${sql.literal(owner.links)} AS links
    JOIN ${sql.literal(owner.history)} AS history
      ON history.${sql.literal(owner.key)} = links.${sql.literal(owner.key)}
      AND history.version = links.version
    WHERE links.run_id = ${runId} AND links.tool_call_id IN ${sql.in(toolCallIds)}`
  )
  const rows = yield* sql<{
    readonly domain: keyof typeof owners
    readonly resource_id: string
    readonly version: number
    readonly kind: string
    readonly tool_call_id: string
    readonly total: number
  }>`SELECT * FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY tool_call_id ORDER BY domain, resource_id, version) AS n,
        COUNT(*) OVER (PARTITION BY tool_call_id) AS total
      FROM (${sql.join(" UNION ALL ")(selects)})
    ) WHERE n <= ${VERSIONS_MAX}
    ORDER BY tool_call_id, domain, resource_id, version`
  for (const row of rows) {
    const identity = { runId, toolCallId: row.tool_call_id }
    const current = read.get(row.tool_call_id) ?? { entries: [], omitted: 0 }
    read.set(row.tool_call_id, {
      entries: [
        ...current.entries,
        {
          entry_id: `${mutationOperationId(identity)}:${row.domain}:${row.resource_id}:${row.version}`,
          domain: row.domain,
          resource_ref: `${row.domain}:${row.resource_id}`,
          outcome: "applied",
          before:
            row.kind === "created"
              ? { kind: "absent" }
              : { kind: "version", version: String(row.version - 1) },
          after: { kind: "version", version: String(row.version) },
          comparison: "versions"
        }
      ],
      omitted: Math.max(0, row.total - VERSIONS_MAX)
    })
  }
  return read
})

type MutationChildren = {
  readonly runs: ChangeEvidence["child_runs"]
  readonly truncated: boolean
}

const spawnedRunSql = Statement.fragment([
  Statement.literal(
    "run.client_id = 'spawn:' || child.parent_run_id || ':' || child.parent_tool_call_id"
  )
])

/** A spawn owns its admitted run only. Later assignments in that Chat never join.
 * UNION and a recursive cap bound malformed/cyclic ancestry as well as large trees.
 * Only agent sessions have a parent call (the sessions CHECK), and saying so
 * lets SQLite use the partial `idx_sessions_agent_origin`; without it every
 * call's read scanned all of `chat_runs` (34 ms each on a 12k-run database). */
export const readMutationChildren = Effect.fn("MutationLinks.children")(function* (
  sql: SqlClient.SqlClient,
  identity: MutationOperationIdentity
) {
  const rows = yield* sql<{
    readonly run_id: string
    readonly session_id: string
    readonly parent_run_id: string
    readonly parent_tool_call_id: string
    readonly status: string
  }>`WITH RECURSIVE ${runDescendants(sql, {
    name: "admitted",
    from: sql`SELECT run.run_id
      FROM sessions AS child JOIN chat_runs AS run ON run.session_id = child.session_id
        AND ${spawnedRunSql}
      WHERE child.session_type = 'agent'
        AND child.parent_run_id = ${identity.runId} AND child.parent_tool_call_id = ${identity.toolCallId}`,
    where: sql`child.session_type = 'agent' AND ${spawnedRunSql}`,
    limit: 101
  })}
  SELECT admitted.run_id, child.session_id, child.parent_run_id, child.parent_tool_call_id, run.status
    FROM admitted JOIN chat_runs AS run USING(run_id)
    JOIN sessions AS child ON child.session_id = run.session_id
    ORDER BY admitted.run_id`
  return { runs: rows.slice(0, 100), truncated: rows.length > 100 }
})

export const readMutationChildrenOf = Effect.fn("MutationLinks.childrenMany")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>
) {
  const read = new Map<string, MutationChildren>()
  for (const toolCallId of toolCallIds) {
    read.set(toolCallId, yield* readMutationChildren(sql, { runId, toolCallId }))
  }
  return read
})
