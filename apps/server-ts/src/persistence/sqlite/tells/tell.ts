import type { ChatProjectionEvent, EntityKind } from "@arden-hq/protocol"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatEventStore } from "../../events/store.js"
import type { SessionLifecycleEvents } from "../../sessions/events.js"
import { toldKey, UnitOfWork } from "../../unit-of-work.js"
import { makeShownAsks } from "../shown-asks.js"
import { drainTouches, scopedSource, scopeKind, type Touch } from "./capture.js"
import { tellInOwnSavepoint } from "./savepoint.js"
import type { TellKind } from "./tables.js"

interface TellContext {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: ChatEventStore["Service"]
}

interface Touched {
  readonly id: string
  readonly scopes: ReadonlySet<string | null>
  readonly sources: ReadonlySet<string>
  readonly renamed: boolean
  readonly unlisted: boolean
  readonly latest: number
}

interface Tell {
  readonly what: string
  readonly tell: Effect.Effect<void, unknown, UnitOfWork>
}

const LIST_LIMIT = 20

const entityChanged = (context: TellContext, kind: EntityKind, id: string | null) =>
  context.sessionEvents.appendEventInTransaction({ type: "entity_changed", kind, id })

const rowsOrList = (
  context: TellContext,
  list: EntityKind,
  rows: ReadonlyArray<Touched>,
  perRow: (row: Touched) => ReadonlyArray<Tell>
): ReadonlyArray<Tell> =>
  rows.length > LIST_LIMIT
    ? [{ what: `${list} list`, tell: entityChanged(context, list, null) }]
    : rows.flatMap(perRow)

const tellRename = Effect.fn("Tells.rename")(function* (context: TellContext, sessionId: string) {
  const [row] = yield* context.sql<{ readonly name: string | null }>`SELECT name FROM sessions
    WHERE session_id = ${sessionId} AND archived_at IS NULL`
  if (row === undefined) return
  yield* context.chatEvents.appendInTransaction({
    sessionId,
    events: [
      {
        event: {
          type: "session_updated",
          session_id: sessionId,
          name: row.name
        } satisfies ChatProjectionEvent
      }
    ]
  })
})

const tellSession = (context: TellContext, row: Touched): Tell => ({
  what: `session ${row.id}`,
  tell: Effect.gen(function* () {
    const through = yield* (yield* UnitOfWork).toldThrough(toldKey.session(row.id))
    if (row.unlisted || through === undefined || through < row.latest)
      yield* entityChanged(context, "session", row.id)
  })
})

const tellSessions = (context: TellContext, rows: ReadonlyArray<Touched>): ReadonlyArray<Tell> => [
  ...rowsOrList(context, "session", rows, (row) => [tellSession(context, row)]),
  ...rows.flatMap((row) =>
    row.renamed ? [{ what: `session name ${row.id}`, tell: tellRename(context, row.id) }] : []
  )
]

const tellTask = Effect.fn("Tells.task")(function* (context: TellContext, row: Touched) {
  const [task] = yield* context.sql<{ readonly space_id: string | null }>`SELECT space_id
    FROM space_tasks WHERE item_id = ${row.id}`
  const [current, ...left] = task === undefined ? [...row.scopes] : [task.space_id, ...row.scopes]
  if (current === undefined) return
  const comment = [...row.sources].every(
    (source) => source === "space_task_comments" || source === "space_task_attachments"
  )
  yield* context.sessionEvents.appendEventInTransaction({
    type: "work_changed",
    space_id: current,
    item_id: row.id,
    change: comment ? "comment" : "status"
  })
  for (const spaceId of new Set(left))
    if (spaceId !== null && spaceId !== current) yield* entityChanged(context, "space", spaceId)
})

const tellProposal = Effect.fn("Tells.proposal")(function* (context: TellContext, id: string) {
  const [proposal] = yield* context.sql<{
    readonly space_id: string | null
    readonly revision: number
    readonly status: "held" | "offered" | "accepted" | "rejected" | "retired"
  }>`SELECT space_id, revision, status FROM task_proposals WHERE proposal_id = ${id}`
  if (proposal === undefined || proposal.space_id === null)
    return yield* entityChanged(context, "proposal", id)
  yield* context.sessionEvents.appendEventInTransaction({
    type: "task_proposal_changed",
    space_id: proposal.space_id,
    proposal_id: id,
    revision: proposal.revision,
    status: proposal.status === "held" ? "offered" : proposal.status
  })
})

const tellFocusChoice = Effect.fn("Tells.focusChoice")(function* (
  context: TellContext,
  questionId: string
) {
  const [choice] = yield* context.sql<{
    readonly space_id: string
    readonly revision: number
    readonly status: "offered" | "settled"
  }>`SELECT space_id, revision, status FROM focus_choices WHERE question_id = ${questionId}`
  if (choice === undefined) return
  yield* context.sessionEvents.appendEventInTransaction({
    type: "focus_choice_changed",
    space_id: choice.space_id,
    question_id: questionId,
    revision: choice.revision,
    status: choice.status
  })
})

const tellVisibility = Effect.fn("Tells.visibility")(function* (
  context: TellContext,
  itemId: string
) {
  const [task] = yield* context.sql<{ readonly space_id: string | null }>`SELECT space_id
    FROM space_tasks WHERE item_id = ${itemId}`
  if (task === undefined) return
  yield* context.sessionEvents.appendEventInTransaction({
    type: "task_visibility_changed",
    space_id: task.space_id,
    item_id: itemId
  })
})

const tellers: Record<
  TellKind,
  (context: TellContext, rows: ReadonlyArray<Touched>) => ReadonlyArray<Tell>
> = {
  session: (context, rows) => tellSessions(context, rows),
  space: (context, rows) =>
    rowsOrList(context, "space", rows, (row) => [
      { what: `Space ${row.id}`, tell: entityChanged(context, "space", row.id) }
    ]),
  automation: (context, rows) =>
    rowsOrList(context, "automation", rows, (row) => [
      { what: `automation ${row.id}`, tell: entityChanged(context, "automation", row.id) }
    ]),
  permission: (context, rows) =>
    rows.length === 0
      ? []
      : [{ what: "permissions", tell: entityChanged(context, "permission", null) }],
  task: (context, rows) =>
    rowsOrList(context, "task", rows, (row) => [
      { what: `task ${row.id}`, tell: tellTask(context, row) }
    ]),
  proposal: (context, rows) =>
    rowsOrList(context, "proposal", rows, (row) => [
      { what: `proposal ${row.id}`, tell: tellProposal(context, row.id) }
    ]),
  focus_choice: (context, rows) =>
    rowsOrList(context, "space", rows, (row) => [
      { what: `focus choice ${row.id}`, tell: tellFocusChoice(context, row.id) }
    ]),
  task_visibility: (context, rows) =>
    rowsOrList(context, "task", rows, (row) => [
      { what: `task visibility ${row.id}`, tell: tellVisibility(context, row.id) }
    ]),
  run_card: () => []
}

const groupTouches = (touches: ReadonlyArray<Touch>) => {
  const kinds = new Map<TellKind, Map<string, Touched>>()
  const add = (kind: TellKind, id: string, touch: Touch) => {
    const rows = kinds.get(kind) ?? new Map<string, Touched>()
    kinds.set(kind, rows)
    const row = rows.get(id)
    rows.set(id, {
      id,
      scopes:
        kind === touch.kind && scopedSource(touch.source)
          ? new Set([...(row?.scopes ?? []), touch.scope])
          : (row?.scopes ?? new Set()),
      sources: new Set([...(row?.sources ?? []), touch.source]),
      renamed: (row?.renamed ?? false) || (kind === touch.kind && touch.renamed !== 0),
      unlisted: (row?.unlisted ?? false) || (kind === touch.kind && touch.unlisted !== 0),
      latest: Math.max(row?.latest ?? 0, kind === touch.kind ? touch.seq : 0)
    })
  }
  for (const touch of touches) {
    if (touch.id !== null) add(touch.kind, touch.id, touch)
    const also = scopeKind(touch.source)
    if (also !== undefined && touch.scope !== null) add(also, touch.scope, touch)
  }
  return kinds
}

const tellTouches = Effect.fn("Tells.tellTouches")(function* (context: TellContext) {
  for (const [kind, rows] of groupTouches(yield* drainTouches(context.sql)))
    for (const { what, tell } of tellers[kind](context, [...rows.values()]))
      yield* tellInOwnSavepoint(context.sql, { what }, tell)
})

export const makeTellAtCommit = (context: TellContext): Effect.Effect<void, never, UnitOfWork> =>
  makeShownAsks(context).pipe(
    Effect.andThen(tellTouches(context)),
    Effect.catchCause((cause) => Effect.logWarning("Could not tell what changed", { cause }))
  )
