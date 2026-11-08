import { Effect } from "effect"
import { disposableForkSql } from "../schema/fork-disposition.js"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"
import { decisionRoutesSql } from "./pending-decision-cards.js"

export interface DecisionRouteRef {
  readonly viewer_session_id: string
  readonly source_session_id: string
  readonly source_kind: "run" | "deferred"
  readonly run_id: string
  readonly tool_call_id: string
  readonly basis:
    | "source_v1"
    | "agent_delegation_v1"
    | "side_outcome_recovery_v1"
    | "automation_creator_v1"
    | "destination_v1"
}

export const loadPendingDecisionRoutes = Effect.fn("DecisionRoutes.loadPending")(function* (
  sql: SqlClient.SqlClient,
  sourceKind: "run" | "deferred",
  runId: string,
  toolCallId: string
) {
  const find = sql<DecisionRouteRef>`
    SELECT viewer_session_id, source_session_id, source_kind, run_id, tool_call_id, basis
    FROM (${decisionRoutesSql(sql)})
    WHERE source_kind = ${sourceKind} AND run_id = ${runId}
      AND tool_call_id = ${toolCallId}
    ORDER BY viewer_session_id`
  const current = yield* find
  if (current.length > 0) return current
  const source =
    sourceKind === "run"
      ? (yield* sql<{ readonly session_id: string; readonly kind: string }>`
        SELECT session_id, kind FROM tool_approvals
        WHERE run_id = ${runId} AND tool_call_id = ${toolCallId}
          AND status = 'pending'`)[0]
      : (yield* sql<{ readonly session_id: string; readonly kind: string }>`
        SELECT session_id, 'tool_approval' AS kind FROM deferred_tool_calls
        WHERE run_id = ${runId} AND tool_call_id = ${toolCallId}
          AND status = 'pending'`)[0]
  if (source === undefined) return []
  const lineage = yield* sql.unsafe<{
    readonly session_id: string
    readonly session_type: string
    readonly edge_valid: number
  }>(decisionLineageSql("?"), [source.session_id])
  const valid =
    lineage.length > 0 &&
    lineage.every((row) => row.edge_valid === 1) &&
    lineage.some((row) => row.session_type !== "agent")
  const recipients: DecisionRouteRef[] = (
    valid
      ? lineage
      : [
          {
            session_id: source.session_id,
            session_type: "chat",
            edge_valid: 1
          }
        ]
  ).map((row) => ({
    viewer_session_id: row.session_id,
    source_session_id: source.session_id,
    source_kind: sourceKind,
    run_id: runId,
    tool_call_id: toolCallId,
    basis: row.session_id === source.session_id ? "source_v1" : "agent_delegation_v1"
  }))
  const side =
    valid && sourceKind === "run" && source.kind === "tool_outcome"
      ? lineage.find((row) => row.session_type === "chat")
      : undefined
  if (side !== undefined) {
    const parent = yield* sql<{ readonly session_id: string }>`
      SELECT owner.session_id FROM session_fork_requests AS fork
      JOIN sessions AS owner ON owner.session_id = fork.source_session_id
        AND owner.session_type = 'chat'
      WHERE fork.child_session_id = ${side.session_id} AND fork.state = 'ready'
        AND json_valid(fork.request_json)
        AND ${sql.literal(disposableForkSql("fork"))}`
    recipients.push(
      ...parent.map((row) => ({
        viewer_session_id: row.session_id,
        source_session_id: source.session_id,
        source_kind: sourceKind,
        run_id: runId,
        tool_call_id: toolCallId,
        basis: "side_outcome_recovery_v1" as const
      }))
    )
  }
  return recipients
})

const cardKey = (route: Pick<DecisionRouteRef, "source_kind" | "run_id" | "tool_call_id">) =>
  `${route.source_kind}\u0000${route.run_id}\u0000${route.tool_call_id}`

const routeKey = (route: DecisionRouteRef) => `${cardKey(route)}\u0000${route.viewer_session_id}`

export interface DecisionRouteChange {
  readonly source_kind: DecisionRouteRef["source_kind"]
  readonly run_id: string
  readonly tool_call_id: string
  readonly opened: ReadonlyArray<DecisionRouteRef>
  readonly closed: ReadonlyArray<DecisionRouteRef>
}

export const decisionRouteChanges = Effect.fn("DecisionRoutes.changes")(function* (
  sql: SqlClient.SqlClient
) {
  const now = yield* sql<DecisionRouteRef>`SELECT viewer_session_id, source_session_id,
    source_kind, run_id, tool_call_id, basis FROM (${decisionRoutesSql(sql)})`
  const journaled = yield* sql<DecisionRouteRef>`SELECT viewer_session_id, source_session_id,
    source_kind, run_id, tool_call_id, route_basis AS basis FROM journaled_decision_routes`
  const nowKeys = new Set(now.map(routeKey))
  const journaledKeys = new Set(journaled.map(routeKey))
  const cards = new Map<string, DecisionRouteChange>()
  const add = (route: DecisionRouteRef, transition: "opened" | "closed") => {
    const card = cards.get(cardKey(route)) ?? {
      source_kind: route.source_kind,
      run_id: route.run_id,
      tool_call_id: route.tool_call_id,
      opened: [],
      closed: []
    }
    cards.set(cardKey(route), { ...card, [transition]: [...card[transition], route] })
  }
  for (const route of now) if (!journaledKeys.has(routeKey(route))) add(route, "opened")
  for (const route of journaled) if (!nowKeys.has(routeKey(route))) add(route, "closed")
  return [...cards.values()]
})

export const journalDecisionRouteChange = Effect.fn("DecisionRoutes.journalChange")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendEventInTransaction">,
  change: DecisionRouteChange
) {
  for (const route of change.closed)
    yield* sql`DELETE FROM journaled_decision_routes WHERE source_kind = ${route.source_kind}
      AND run_id = ${route.run_id} AND tool_call_id = ${route.tool_call_id}
      AND viewer_session_id = ${route.viewer_session_id}`
  for (const route of change.opened)
    yield* sql`INSERT INTO journaled_decision_routes (source_kind, run_id, tool_call_id,
        viewer_session_id, source_session_id, route_basis)
      VALUES (${route.source_kind}, ${route.run_id}, ${route.tool_call_id},
        ${route.viewer_session_id}, ${route.source_session_id}, ${route.basis})`
  const transitions = [
    ...change.opened.map((route) => ({ route, transition: "opened" as const })),
    ...change.closed.map((route) => ({ route, transition: "closed" as const }))
  ]
  for (const { route, transition } of transitions)
    yield* sessionEvents.appendEventInTransaction({
      type: "decision_route_changed",
      transition,
      ...route,
      produced_by: null,
      chain_depth: 0
    })
})
