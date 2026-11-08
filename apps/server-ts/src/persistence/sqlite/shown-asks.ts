import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  ConnectionRequiredDataSchema,
  pendingConnectionDecision
} from "../../connections/recovery.js"
import type { EventDraft } from "../events/model.js"
import type { ChatEventStore } from "../events/store.js"
import { JsonObjectSchema } from "../json.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { toldKey, UnitOfWork } from "../unit-of-work.js"
import { announceRunAskChange } from "./ask-changes.js"
import { decisionRoutesSql } from "./pending-decision-cards.js"
import {
  decisionRouteChanges,
  journalDecisionRouteChange,
  type DecisionRouteChange,
  type DecisionRouteRef
} from "./decision-route-journal.js"
import {
  appendQuestionChange,
  questionVisiblePredicate,
  runAsksVisiblePredicate
} from "./question-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { tellInOwnSavepoint } from "./tells/savepoint.js"
import { appendEscalatedApprovalDraft } from "./tool-approvals.js"

type AskKind = "question" | "card"

interface ShownAsk {
  readonly ask_kind: AskKind
  readonly run_id: string
  readonly ask_id: string
  readonly viewer_session_id: string
  readonly route_basis: DecisionRouteRef["basis"] | null
}

const rowKey = (row: ShownAsk) =>
  `${row.ask_kind}\u0000${row.run_id}\u0000${row.ask_id}\u0000${row.viewer_session_id}`

const shownNow = (sql: SqlClient.SqlClient) => sql<ShownAsk>`
  SELECT 'question' AS ask_kind, question.run_id, question.question_id AS ask_id,
    ${runDestinationSessionId(sql, runColumns(sql, "run"))} AS viewer_session_id,
    NULL AS route_basis
  FROM run_questions AS question JOIN chat_runs AS run ON run.run_id = question.run_id
  WHERE ${questionVisiblePredicate({
    sql,
    run: runColumns(sql, "run"),
    resolution: sql`question.resolution`,
    closedAt: sql`question.closed_at`
  })}
  UNION ALL
  SELECT 'card', card.run_id, card.tool_call_id, visibility.viewer_session_id,
    visibility.basis
  FROM deferred_tool_calls AS card
  JOIN (${decisionRoutesSql(sql)}) AS visibility ON visibility.source_kind = 'deferred'
    AND visibility.run_id = card.run_id AND visibility.tool_call_id = card.tool_call_id
  JOIN chat_runs AS card_run ON card_run.run_id = card.run_id
    AND ${runAsksVisiblePredicate(sql, runColumns(sql, "card_run"))}
  WHERE card.status = 'pending'`

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))

const cardClosedEvent = (
  card: {
    readonly source_kind: DecisionRouteRef["source_kind"]
    readonly run_id: string
    readonly session_id: string
    readonly tool_call_id: string
  },
  payloadJson: string,
  approved: boolean
): ChatProjectionEvent => {
  const payload = Option.getOrUndefined(decodeObject(payloadJson))
  const connection = Option.getOrUndefined(
    Schema.decodeUnknownOption(ConnectionRequiredDataSchema)(payload?.["approval_data"])
  )
  const decisionRoute = {
    source_kind: card.source_kind,
    source_session_id: card.session_id,
    basis: "source_v1"
  } as const
  return connection === undefined
    ? {
        type: "approval_resolved",
        run_id: card.run_id,
        tool_id: card.tool_call_id,
        approved,
        decision_route: decisionRoute
      }
    : {
        type: "connection_resolved",
        run_id: card.run_id,
        tool_id: card.tool_call_id,
        connection_id: pendingConnectionDecision(
          { runId: card.run_id, sessionId: card.session_id, toolCallId: card.tool_call_id },
          connection
        ).snapshot.connection_id,
        approved,
        decision_route: decisionRoute
      }
}

const groupByAsk = (rows: ReadonlyArray<ShownAsk>) => {
  const asks = new Map<string, Array<ShownAsk>>()
  for (const row of rows) {
    const key =
      row.ask_kind === "question"
        ? toldKey.question(row.ask_id)
        : toldKey.card(row.run_id, row.ask_id)
    asks.set(key, [...(asks.get(key) ?? []), row])
  }
  return asks
}

const reconcile = Effect.fn("ShownAsks.reconcile")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: ChatEventStore["Service"]
}) {
  const { sql } = options
  const routed = new Set<string>()
  for (const change of yield* decisionRouteChanges(sql)) {
    if (change.source_kind === "run" && change.closed.length > 0)
      routed.add(toldKey.card(change.run_id, change.tool_call_id))
    yield* tellInOwnSavepoint(
      sql,
      { card: `${change.source_kind}:${change.run_id}:${change.tool_call_id}` },
      tellRouteChange(options, change)
    )
  }
  for (const card of yield* runCardsClosedNow(sql))
    if (!routed.has(toldKey.card(card.run_id, card.tool_call_id)))
      yield* tellInOwnSavepoint(
        sql,
        { card: `run:${card.run_id}:${card.tool_call_id}` },
        tellRunCardClosed(options, card, [
          {
            viewer_session_id: card.session_id,
            source_session_id: card.session_id,
            source_kind: "run",
            run_id: card.run_id,
            tool_call_id: card.tool_call_id,
            basis: "source_v1"
          }
        ])
      )
  const now = yield* shownNow(sql)
  const told = yield* sql<ShownAsk>`SELECT ask_kind, run_id, ask_id, viewer_session_id,
    route_basis FROM shown_asks`
  const nowKeys = new Set(now.map(rowKey))
  const toldKeys = new Set(told.map(rowKey))
  const appeared = groupByAsk(now.filter((row) => !toldKeys.has(rowKey(row))))
  const vanished = groupByAsk(told.filter((row) => !nowKeys.has(rowKey(row))))
  const unit = yield* UnitOfWork
  for (const key of new Set([...appeared.keys(), ...vanished.keys()])) {
    const change = { appeared: appeared.get(key) ?? [], vanished: vanished.get(key) ?? [] }
    yield* tellInOwnSavepoint(
      sql,
      { ask: key },
      Effect.gen(function* () {
        yield* record(sql, change)
        if ((yield* unit.toldThrough(key)) === undefined) yield* tellAsk({ ...options, ...change })
      })
    )
  }
})

const record = Effect.fn("ShownAsks.record")(function* (
  sql: SqlClient.SqlClient,
  change: { readonly appeared: ReadonlyArray<ShownAsk>; readonly vanished: ReadonlyArray<ShownAsk> }
) {
  for (const row of change.vanished)
    yield* sql`DELETE FROM shown_asks WHERE ask_kind = ${row.ask_kind} AND run_id = ${row.run_id}
      AND ask_id = ${row.ask_id} AND viewer_session_id = ${row.viewer_session_id}`
  for (const row of change.appeared)
    yield* sql`INSERT INTO shown_asks (ask_kind, run_id, ask_id, viewer_session_id, route_basis)
      VALUES (${row.ask_kind}, ${row.run_id}, ${row.ask_id}, ${row.viewer_session_id},
        ${row.route_basis})`
})

const tellAsk = Effect.fn("ShownAsks.tell")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: ChatEventStore["Service"]
  readonly appeared: ReadonlyArray<ShownAsk>
  readonly vanished: ReadonlyArray<ShownAsk>
}) {
  const { sql, sessionEvents, chatEvents, appeared, vanished } = options
  const rows = [...appeared, ...vanished]
  const ask = rows[0]
  if (ask === undefined) return
  const told =
    ask.ask_kind === "question"
      ? yield* appendQuestionChange({ sql, sessionEvents, questionId: ask.ask_id })
      : yield* tellClosedCard({ sql, sessionEvents, chatEvents, ask, vanished })
  if (!told) yield* readAsksAgain(chatEvents, rows)
  yield* announceRunAskChange(sql, sessionEvents, ask.run_id)
})

const readAsksAgain = (
  chatEvents: ChatEventStore["Service"],
  rows: ReadonlyArray<{ readonly viewer_session_id: string }>
) =>
  Effect.forEach(
    new Set(rows.map((row) => row.viewer_session_id)),
    (viewer) =>
      chatEvents.appendInTransaction({
        sessionId: viewer,
        events: [{ event: { type: "transcript_changed" } satisfies ChatProjectionEvent }]
      }),
    { discard: true }
  )

const tellClosedCard = Effect.fn("ShownAsks.tellClosedCard")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: ChatEventStore["Service"]
  readonly ask: ShownAsk
  readonly vanished: ReadonlyArray<ShownAsk>
}) {
  const { sql, chatEvents, ask } = options
  const [card] = yield* sql<{
    readonly session_id: string
    readonly status: string
    readonly payload_json: string
  }>`SELECT session_id, status, payload_json FROM deferred_tool_calls
    WHERE run_id = ${ask.run_id} AND tool_call_id = ${ask.ask_id}`
  if (card === undefined || card.status === "pending") return false
  const routes: Array<DecisionRouteRef> = options.vanished.map((row) => ({
    viewer_session_id: row.viewer_session_id,
    source_session_id: card.session_id,
    source_kind: "deferred",
    run_id: row.run_id,
    tool_call_id: row.ask_id,
    basis: row.route_basis ?? "source_v1"
  }))
  const draft: EventDraft = {
    event: cardClosedEvent(
      {
        source_kind: "deferred",
        run_id: ask.run_id,
        session_id: card.session_id,
        tool_call_id: ask.ask_id
      },
      card.payload_json,
      card.status !== "rejected"
    ),
    runId: ask.run_id
  }
  yield* appendEscalatedApprovalDraft(sql, chatEvents, card.session_id, draft, routes, true)
  return true
})

const tellRouteChange = Effect.fn("ShownAsks.tellRouteChange")(function* (
  options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly chatEvents: ChatEventStore["Service"]
  },
  change: DecisionRouteChange
) {
  const { sql, sessionEvents, chatEvents } = options
  yield* journalDecisionRouteChange(sql, sessionEvents, change)
  if (change.source_kind !== "run" || change.closed.length === 0) return
  const [card] = yield* sql<RunCard>`SELECT run_id, tool_call_id, session_id, status,
    payload_json FROM tool_approvals
    WHERE run_id = ${change.run_id} AND tool_call_id = ${change.tool_call_id}`
  if (card?.status === "pending")
    return yield* readAsksAgain(chatEvents, [...change.closed, ...change.opened])
  if (card === undefined) return yield* readAsksAgain(chatEvents, change.closed)
  yield* tellRunCardClosed(options, card, change.closed)
})

interface RunCard {
  readonly run_id: string
  readonly tool_call_id: string
  readonly session_id: string
  readonly status: string
  readonly payload_json: string
}

const runCardsClosedNow = (sql: SqlClient.SqlClient) =>
  sql<RunCard>`SELECT DISTINCT card.run_id, card.tool_call_id, card.session_id, card.status,
      card.payload_json
    FROM temp.told_touches AS touched
    JOIN tool_approvals AS card ON card.run_id = json_extract(touched.id, '$[0]')
      AND card.tool_call_id = json_extract(touched.id, '$[1]')
    WHERE touched.kind = 'run_card' AND card.status <> 'pending'`.pipe(
    Effect.orElseSucceed((): ReadonlyArray<RunCard> => [])
  )

const tellRunCardClosed = Effect.fn("ShownAsks.tellRunCardClosed")(function* (
  options: {
    readonly sql: SqlClient.SqlClient
    readonly chatEvents: ChatEventStore["Service"]
  },
  card: RunCard,
  routes: ReadonlyArray<DecisionRouteRef>
) {
  const draft: EventDraft = {
    event: cardClosedEvent(
      {
        source_kind: "run",
        run_id: card.run_id,
        session_id: card.session_id,
        tool_call_id: card.tool_call_id
      },
      card.payload_json,
      card.status !== "rejected"
    ),
    runId: card.run_id
  }
  yield* appendEscalatedApprovalDraft(
    options.sql,
    options.chatEvents,
    card.session_id,
    draft,
    routes,
    true
  )
})

export const makeShownAsks = (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: ChatEventStore["Service"]
}): Effect.Effect<void, never, UnitOfWork> =>
  reconcile(options).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not tell chats which asks they show", { cause })
    )
  )
