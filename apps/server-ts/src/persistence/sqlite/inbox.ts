import { quoted } from "@arden-hq/std/count"
import { taskHasHold } from "./task-hold-state.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { failureRows } from "./inbox-failure-rows.js"
import { decodeRunApproval, type ApprovalRow } from "./run-approvals.js"
import { INBOX_ITEM_LIMIT } from "@arden-hq/protocol/inbox"
import {
  blockedSpaceGroups,
  blockedTaskEntries,
  group,
  type CommentRow,
  type TaskRow
} from "./inbox-blocked.js"
import { DateTime, Effect } from "effect"
import { planLimitEntries, planLimitNoticeRows } from "./inbox-plan-limit.js"
import { SqlClient } from "effect/unstable/sql"
import {
  InboxStore,
  InboxStoreError,
  type InboxApprovalEntry,
  type InboxBlockedTaskEntry,
  type InboxDismissScope,
  type InboxEntry,
  type InboxEntryGroup,
  type InboxFailureEntry,
  type InboxIncidentEntry,
  type InboxQuestionEntry,
  type InboxReadScope,
  type InboxState,
  type OpenAsks
} from "../inbox/store.js"
import type { RunApproval, RunQuestion } from "@arden-hq/protocol/runs"
import { makeRunQuestionReader, type QuestionRow } from "./run-question-read.js"
import { MAX_SCRIPT_RESULT_ATTEMPTS } from "../scripts/results.js"
import type { PersistenceDeps } from "./deps.js"
import {
  automationFailureEntries,
  collapseWhitespace,
  failureCause,
  timeValue,
  unread,
  type SpacePauseRow,
  type FailureRow,
  type PauseRow
} from "./inbox-failures.js"
import { taskOpenSql } from "./task-status-sql.js"

const FAILURE_WINDOW_DAYS = 7

interface SpaceRow {
  readonly space_id: string
  readonly name: string
}

interface AbandonedDeliveryRow {
  readonly workflow_ref: string
  readonly attempt: number
  readonly origin_run_id: string
  readonly space_id: string | null
  readonly chat_name: string | null
  readonly last_error: string | null
  readonly settled_at: string
}

interface IncidentRow {
  readonly incident_id: string
  readonly delivery_id: string
  readonly code: "delivery.unroutable"
  readonly summary: string
  readonly source_run_id: string
  readonly created_at: string
}

interface ReadRow {
  readonly item_key: string
  readonly read_at: string
}

interface DismissRow {
  readonly item_key: string
  readonly dismissed_at: string
}

interface Snapshot {
  readonly questions: ReadonlyArray<RunQuestion>
  readonly now: string
  readonly spaces: ReadonlyArray<SpaceRow>
  readonly tasks: ReadonlyArray<TaskRow>
  readonly comments: ReadonlyArray<CommentRow>
  readonly approvals: ReadonlyArray<RunApproval>
  readonly failures: ReadonlyArray<FailureRow>
  readonly pauses: ReadonlyArray<PauseRow>
  readonly spacePauses: ReadonlyArray<SpacePauseRow>
  readonly abandonedDeliveries: ReadonlyArray<AbandonedDeliveryRow>
  readonly incidents: ReadonlyArray<IncidentRow>
  readonly marks: ReadonlyArray<ReadRow>
  readonly dismissals: ReadonlyArray<DismissRow>
  readonly planLimitNotice: string | undefined
}

type StoreOperation = "view" | "mark_read" | "dismiss"
type OpenAsksOperation = StoreOperation | "open_asks"

interface Projection {
  readonly view: InboxState
  readonly live: ReadonlyArray<{ readonly key: string; readonly groupKey: string }>
}

const storeError = (
  operation: OpenAsksOperation,
  reason: "invalid" | "not_found" | "storage",
  message: string,
  cause?: unknown
): InboxStoreError =>
  new InboxStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const abandonedDeliveryCause = (row: AbandonedDeliveryRow): string => {
  const chat =
    row.chat_name === null || collapseWhitespace(row.chat_name).length === 0
      ? "its chat"
      : quoted(row.chat_name)
  const reason = row.last_error === null ? "no error was recorded" : failureCause(row.last_error)
  return `Workflow result never reached ${chat}: ${reason}`
}

const isLowerAlphaNumeric = (character: string): boolean => {
  const code = character.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

const spokenDescription = (value: string | null): string | null => {
  if (value === null) return null
  let text = value
  let searchFrom = 0
  while (searchFrom < text.length) {
    const open = text.indexOf("(", searchFrom)
    if (open < 0) break
    const close = text.indexOf(")", open + 1)
    if (close < 0) break
    const inner = text.slice(open + 1, close)
    const tilde = inner.indexOf("~")
    const suffix = tilde < 0 ? "" : inner.slice(tilde + 1)
    if (suffix.length >= 4 && [...suffix].every(isLowerAlphaNumeric)) {
      text = `${text.slice(0, open).trimEnd()}${text.slice(close + 1)}`
      searchFrom = open
    } else {
      searchFrom = close + 1
    }
  }
  const result = collapseWhitespace(text)
  return result.length === 0 ? null : result
}

const byRecency = <T extends { readonly at: string; readonly key: string }>(
  items: ReadonlyArray<T>
): Array<T> =>
  [...items].sort((left, right) => {
    const difference = timeValue(right.at) - timeValue(left.at)
    return difference === 0 || Number.isNaN(difference)
      ? right.key.localeCompare(left.key)
      : difference
  })

const newestFirst = <T>(
  items: ReadonlyArray<T>,
  at: (item: T) => string,
  key: (item: T) => string
): Array<T> =>
  byRecency(items.map((item) => ({ item, at: at(item), key: key(item) }))).map(({ item }) => item)

const approvalKey = (approval: RunApproval): string =>
  `approval:${approval.run_id}:${approval.tool_call_id}`

const capGroups = (groups: ReadonlyArray<InboxEntryGroup>): Array<InboxEntryGroup> => {
  const result: Array<InboxEntryGroup> = []
  let remaining = INBOX_ITEM_LIMIT
  for (const current of groups) {
    if (remaining <= 0) break
    const items = current.items.slice(0, remaining)
    remaining -= items.length
    result.push({ ...current, items, count: items.filter((item) => item.counted).length })
  }
  return result
}

const query = <A>(
  operation: OpenAsksOperation,
  statement: Effect.Effect<ReadonlyArray<A>, unknown>
): Effect.Effect<ReadonlyArray<A>, InboxStoreError> =>
  statement.pipe(
    Effect.mapError((cause) => storeError(operation, "storage", "Could not read Inbox data", cause))
  )

const makeOpenAsksLoader = (sql: SqlClient.SqlClient) => {
  const questionReader = makeRunQuestionReader(sql)
  return Effect.fn("SqliteInbox.loadOpenAsks")(function* (
    operation: OpenAsksOperation
  ): Effect.fn.Return<OpenAsks, InboxStoreError> {
    const questionRows = yield* query(
      operation,
      sql<QuestionRow>`SELECT * FROM (${questionReader.openSelect}) WHERE status = 'open'`
    )
    const questions = yield* Effect.forEach(questionRows, questionReader.decode).pipe(
      Effect.mapError((cause) =>
        storeError(operation, "storage", "Could not read Inbox questions", cause)
      )
    )
    const approvalRows = yield* query(
      operation,
      sql<ApprovalRow>`
      SELECT run_id, session_id, destination_session_id, work_json, tool_call_id, tool_name, action,
             scope, preview, diff, requested_at, kind, payload_json, source
      FROM (${pendingDecisionCards(sql)})
    `
    )
    const approvals = yield* Effect.forEach(approvalRows, (row) =>
      decodeRunApproval(row).pipe(
        Effect.mapError((cause) =>
          storeError(operation, "storage", "Stored Inbox approval payload is corrupt", cause)
        ),
        Effect.map((approval): RunApproval => ({
          ...approval,
          description: spokenDescription(approval.description)
        }))
      )
    )
    return {
      questions: newestFirst(
        questions,
        (question) => question.created_at,
        (question) => question.question_id
      ),
      approvals: newestFirst(approvals, (approval) => approval.at, approvalKey)
    }
  })
}

const makeSnapshotLoader = (sql: SqlClient.SqlClient) => {
  const loadOpenAsks = makeOpenAsksLoader(sql)
  return Effect.fn("SqliteInbox.loadSnapshot")(function* (
    operation: StoreOperation,
    now: string,
    cutoff: string
  ): Effect.fn.Return<Snapshot, InboxStoreError> {
    const { questions, approvals } = yield* loadOpenAsks(operation)
    const spaces = yield* query(
      operation,
      sql<SpaceRow>`
      SELECT space_id, name
      FROM spaces
      WHERE archived_at IS NULL
    `
    )

    const tasks = yield* query(
      operation,
      sql<TaskRow>`
      SELECT item.item_id, item.space_id, item.stable_key, item.seq,
             item.text, item.waiting_on, item.updated_at
      FROM space_tasks AS item
      LEFT JOIN spaces AS space ON space.space_id = item.space_id
      WHERE (item.space_id IS NULL OR space.archived_at IS NULL)
        AND item.blocked = 1
        AND NOT ${taskHasHold(sql, sql`item`)}
        AND ${taskOpenSql("item")}
    `
    )

    const comments =
      tasks.length === 0
        ? []
        : yield* query(
            operation,
            sql<CommentRow>`
        SELECT item_id, body, created_at
        FROM (
          SELECT comment.item_id, comment.body, comment.created_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY comment.item_id
                   ORDER BY julianday(comment.created_at) DESC, comment.comment_id DESC
                 ) AS recency
          FROM space_task_comments AS comment
          JOIN space_tasks AS item
            ON item.item_id = comment.item_id
           AND item.blocked = 1
           AND ${taskOpenSql("item")}
          LEFT JOIN spaces AS space ON space.space_id = item.space_id
          -- Only an ask reaches the Inbox, and it reaches it AS the block, not
          -- as a comment, and never one the owner wrote themselves — the public
          -- comment contract permits a user-authored ask.
          -- A note or a result is workspace content: the ticket
          -- already renders the whole trail with a composer, and copying the
          -- latest one here moved a read row's timestamp and made it unread
          -- again for something nobody was asked about.
          WHERE comment.kind = 'ask' AND comment.author != 'user'
            AND (item.space_id IS NULL OR space.archived_at IS NULL)
        )
        WHERE recency = 1
      `
          )

    const failures = yield* query(operation, failureRows(sql, cutoff))

    const pauses = yield* query(
      operation,
      sql<PauseRow>`
      SELECT task_id, json_extract(payload, '$.attemptId') AS attempt_id,
        json_extract(payload, '$.resumedAt') IS NOT NULL AS resumed
      FROM automation_deliveries
      WHERE task_id IS NOT NULL AND json_extract(payload, '$.kind') = 'automation_paused'
    `
    )

    const spacePauses = yield* query(
      operation,
      sql<SpacePauseRow>`
      SELECT delivery_id, task_id, created_at FROM automation_deliveries
      WHERE task_id IS NOT NULL AND json_extract(payload, '$.kind') = 'automation_space_paused'
        AND json_extract(payload, '$.resumedAt') IS NULL
    `
    )

    const abandonedDeliveries = yield* query(
      operation,
      sql<AbandonedDeliveryRow>`
      SELECT json_extract(delivery.payload, '$.workflowRef') AS workflow_ref,
             json_extract(delivery.payload, '$.attempt') AS attempt,
             json_extract(delivery.payload, '$.originRunId') AS origin_run_id,
             session.space_id, session.name AS chat_name,
             delivery.last_error, delivery.created_at AS settled_at
      FROM automation_deliveries AS delivery
      JOIN sessions AS session
        ON session.session_id = json_extract(delivery.payload, '$.sessionId')
      WHERE delivery.status = 'pending'
        AND json_extract(delivery.payload, '$.kind') = 'script_result'
        AND delivery.attempt_count >= ${MAX_SCRIPT_RESULT_ATTEMPTS}
    `
    )

    const incidents = yield* query(
      operation,
      sql<IncidentRow>`
      SELECT incident_id, delivery_id, code, summary, source_run_id, created_at
      FROM delivery_incidents
    `
    )

    const marks = yield* query(
      operation,
      sql<ReadRow>`
      SELECT item_key, read_at
      FROM inbox_reads
    `
    )

    const dismissals = yield* query(
      operation,
      sql<DismissRow>`
      SELECT item_key, dismissed_at
      FROM inbox_dismissals
    `
    )

    const notices = yield* query(operation, planLimitNoticeRows(sql))

    return {
      now,
      spaces,
      tasks,
      comments,
      approvals,
      failures,
      pauses,
      spacePauses,
      abandonedDeliveries,
      incidents,
      marks,
      dismissals,
      questions,
      planLimitNotice: notices[0]?.state
    }
  })
}

export const makeInboxStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): InboxStore["Service"] => {
  const sql = writer.sql
  const readSnapshot = makeSnapshotLoader(reader)
  const readOpenAsks = makeOpenAsksLoader(reader)
  const loadSnapshot = makeSnapshotLoader(sql)

  const makeProjection = Effect.fn("SqliteInbox.makeProjection")(function* (
    operation: StoreOperation,
    snapshot: Snapshot
  ): Effect.fn.Return<Projection, InboxStoreError> {
    const spaceTitles = new Map(snapshot.spaces.map((space) => [space.space_id, space.name]))
    const marks = new Map(snapshot.marks.map((mark) => [mark.item_key, mark.read_at]))
    const latestComments = new Map(snapshot.comments.map((comment) => [comment.item_id, comment]))
    const dismissals = new Map(
      snapshot.dismissals.map((mark) => [mark.item_key, mark.dismissed_at])
    )
    const shown = (item: InboxEntry): boolean => unread(item.at, dismissals.get(item.key))

    const tasks = snapshot.tasks.filter(
      (task): task is TaskRow & { readonly waiting_on: InboxBlockedTaskEntry["waitingOn"] } =>
        task.waiting_on === "you" || task.waiting_on === "external"
    )
    if (tasks.length !== snapshot.tasks.length) {
      return yield* storeError(operation, "storage", "Stored Inbox data is corrupt")
    }
    const sortedBlocked = byRecency(blockedTaskEntries(tasks, latestComments, spaceTitles, marks))
    const spaceGroups = blockedSpaceGroups(sortedBlocked.filter(shown)).sort((left, right) => {
      const leftAt = left.items[0]?.at ?? ""
      const rightAt = right.items[0]?.at ?? ""
      return timeValue(rightAt) - timeValue(leftAt)
    })

    const approvalItems = snapshot.approvals.map((approval): InboxApprovalEntry => {
      const key = approvalKey(approval)
      return {
        source: "approval",
        key,
        groupKey: "approvals",
        at: approval.at,
        counted: true,
        unread: unread(approval.at, marks.get(key)),
        readAt: marks.get(key),
        approval
      }
    })
    const sortedApprovals = byRecency(approvalItems)

    const failureItems = automationFailureEntries({
      failures: snapshot.failures,
      pauses: snapshot.pauses,
      spacePauses: snapshot.spacePauses,
      spaceTitles,
      marks
    })
    const abandonedItems = snapshot.abandonedDeliveries.map((row): InboxFailureEntry => {
      const key = `failure:workflow:${row.workflow_ref}:${row.attempt}`
      const title = row.space_id === null ? undefined : spaceTitles.get(row.space_id)
      return {
        source: "failure",
        key,
        groupKey: "failures",
        at: row.settled_at,
        counted: true,
        unread: unread(row.settled_at, marks.get(key)),
        readAt: marks.get(key),
        space:
          row.space_id === null || title === undefined
            ? { kind: "loose" }
            : { kind: "space", space_id: row.space_id, title },
        origin: { kind: "workflow", workflow_ref: row.workflow_ref, run_id: row.origin_run_id },
        cause: abandonedDeliveryCause(row),
        runCount: 1,
        firstAt: row.settled_at,
        lastAt: row.settled_at,
        automationPaused: false
      }
    })
    const sortedFailures = byRecency([...failureItems, ...abandonedItems])

    const incidentItems = byRecency(
      snapshot.incidents.map((incident): InboxIncidentEntry => {
        const key = incident.incident_id
        return {
          source: "incident",
          key,
          groupKey: "incidents",
          at: incident.created_at,
          counted: true,
          unread: unread(incident.created_at, marks.get(key)),
          readAt: marks.get(key),
          incidentId: incident.incident_id,
          code: incident.code,
          summary: incident.summary,
          deliveryId: incident.delivery_id,
          sourceRunId: incident.source_run_id
        }
      })
    )

    const planItems = yield* planLimitEntries(operation, snapshot.planLimitNotice, marks, unread)
    const shownPlan = planItems.filter(shown)
    const shownApprovals = sortedApprovals.filter(shown)
    const shownFailures = sortedFailures.filter(shown)
    const shownIncidents = incidentItems.filter(shown)
    const questionItems = byRecency(
      snapshot.questions.map((question): InboxQuestionEntry => ({
        source: "question",
        key: question.question_id,
        groupKey: "questions",
        at: question.created_at,
        counted: true,
        unread: unread(question.created_at, marks.get(question.question_id)),
        readAt: marks.get(question.question_id),
        question
      }))
    )
    const shownQuestions = questionItems.filter(shown)
    const allItems: Array<InboxEntry> = [
      ...shownPlan,
      ...shownQuestions,
      ...sortedBlocked.filter(shown),
      ...shownApprovals,
      ...shownIncidents,
      ...shownFailures
    ]
    const groups: Array<InboxEntryGroup> = [
      ...(shownPlan.length === 0
        ? []
        : [group("limits", "Plan limit", shownPlan, { kind: "limits" })]),
      ...(shownQuestions.length === 0
        ? []
        : [group("questions", "Questions", shownQuestions, { kind: "questions" })]),
      ...spaceGroups,
      ...(shownApprovals.length === 0
        ? []
        : [group("approvals", "Approvals", shownApprovals, { kind: "approvals" })]),
      ...(shownIncidents.length === 0
        ? []
        : [group("incidents", "Delivery issues", shownIncidents, { kind: "incidents" })]),
      ...(shownFailures.length === 0
        ? []
        : [group("failures", "Failures", shownFailures, { kind: "failures" })])
    ]
    return {
      view: {
        generatedAt: snapshot.now,
        count: allItems.filter((item) => item.counted).length,
        unreadCount: allItems.filter((item) => item.counted && item.unread).length,
        totalItems: allItems.length,
        truncated: allItems.length > INBOX_ITEM_LIMIT,
        groups: capGroups(groups)
      },
      live: [
        ...planItems,
        ...questionItems,
        ...sortedBlocked,
        ...sortedApprovals,
        ...incidentItems,
        ...sortedFailures
      ].map((item) => ({ key: item.key, groupKey: item.groupKey }))
    }
  })

  const view = Effect.fn("SqliteInbox.view")(function* (): Effect.fn.Return<
    InboxState,
    InboxStoreError
  > {
    const observedAt = yield* DateTime.now
    const now = DateTime.formatIso(observedAt)
    const cutoff = DateTime.formatIso(DateTime.subtract(observedAt, { days: FAILURE_WINDOW_DAYS }))
    return yield* makeProjection("view", yield* readSnapshot("view", now, cutoff)).pipe(
      Effect.map(({ view }) => view),
      Effect.mapError((cause) =>
        cause instanceof InboxStoreError
          ? cause
          : storeError("view", "storage", "Could not load Inbox", cause)
      )
    )
  })

  const markRead = Effect.fn("SqliteInbox.markRead")(function* (
    request: InboxReadScope
  ): Effect.fn.Return<InboxState, InboxStoreError> {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const observedAt = yield* DateTime.now
          const now = DateTime.formatIso(observedAt)
          const cutoff = DateTime.formatIso(
            DateTime.subtract(observedAt, { days: FAILURE_WINDOW_DAYS })
          )
          const snapshot = yield* loadSnapshot("mark_read", now, cutoff)
          const projection = yield* makeProjection("mark_read", snapshot)
          const liveKeys = new Set(projection.live.map((item) => item.key))
          const requested = request.scope === "all" ? [] : [...new Set(request.keys)]
          const keys = request.scope === "all" ? [...liveKeys] : requested
          const unknown = requested.filter((key) => !liveKeys.has(key))
          if (unknown.length > 0) {
            return yield* storeError(
              "mark_read",
              "not_found",
              `Inbox item is no longer available: ${unknown[0]}`
            )
          }

          const stale = snapshot.marks
            .map((mark) => mark.item_key)
            .filter((key) => !liveKeys.has(key))
          if (stale.length > 0)
            yield* sql`DELETE FROM inbox_reads WHERE item_key IN ${sql.in(stale)}`
          if (keys.length > 0) {
            yield* sql`
            INSERT INTO inbox_reads ${sql.insert(keys.map((key) => ({ item_key: key, read_at: now })))}
            ON CONFLICT(item_key) DO UPDATE SET read_at = excluded.read_at
          `
          }

          const marks = new Map(
            snapshot.marks
              .filter((mark) => liveKeys.has(mark.item_key))
              .map((mark) => [mark.item_key, mark.read_at])
          )
          for (const key of keys) marks.set(key, now)
          return (yield* makeProjection("mark_read", {
            ...snapshot,
            marks: [...marks.entries()].map(([item_key, read_at]) => ({ item_key, read_at }))
          })).view
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof InboxStoreError
            ? cause
            : storeError("mark_read", "storage", "Could not mark Inbox items read", cause)
        )
      )
  })

  const dismiss = Effect.fn("SqliteInbox.dismiss")(function* (
    request: InboxDismissScope
  ): Effect.fn.Return<InboxState, InboxStoreError> {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const observedAt = yield* DateTime.now
          const now = DateTime.formatIso(observedAt)
          const cutoff = DateTime.formatIso(
            DateTime.subtract(observedAt, { days: FAILURE_WINDOW_DAYS })
          )
          const snapshot = yield* loadSnapshot("dismiss", now, cutoff)
          const projection = yield* makeProjection("dismiss", snapshot)
          const liveKeys = new Set(projection.live.map((item) => item.key))
          const requested = request.scope === "items" ? [...new Set(request.keys)] : []
          let keys = requested
          if (request.scope === "all") {
            keys = [...liveKeys]
          } else if (request.scope === "group") {
            keys = projection.live
              .filter((item) => item.groupKey === request.groupKey)
              .map((item) => item.key)
          }
          const unknown = requested.filter((key) => !liveKeys.has(key))
          if (unknown.length > 0) {
            return yield* storeError(
              "dismiss",
              "not_found",
              `Inbox item is no longer available: ${unknown[0]}`
            )
          }
          if (request.scope === "group" && keys.length === 0) {
            return yield* storeError(
              "dismiss",
              "not_found",
              `Inbox group is no longer available: ${request.groupKey}`
            )
          }

          const stale = snapshot.dismissals
            .map((mark) => mark.item_key)
            .filter((key) => !liveKeys.has(key))
          if (stale.length > 0)
            yield* sql`DELETE FROM inbox_dismissals WHERE item_key IN ${sql.in(stale)}`
          if (keys.length > 0) {
            yield* sql`
            INSERT INTO inbox_dismissals ${sql.insert(keys.map((key) => ({ item_key: key, dismissed_at: now })))}
            ON CONFLICT(item_key) DO UPDATE SET dismissed_at = excluded.dismissed_at
          `
          }

          const dismissals = new Map(
            snapshot.dismissals
              .filter((mark) => liveKeys.has(mark.item_key))
              .map((mark) => [mark.item_key, mark.dismissed_at])
          )
          for (const key of keys) dismissals.set(key, now)
          return (yield* makeProjection("dismiss", {
            ...snapshot,
            dismissals: [...dismissals.entries()].map(([item_key, dismissed_at]) => ({
              item_key,
              dismissed_at
            }))
          })).view
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof InboxStoreError
            ? cause
            : storeError("dismiss", "storage", "Could not dismiss Inbox items", cause)
        )
      )
  })

  const openAsks = () => readOpenAsks("open_asks")

  return InboxStore.of({ view, openAsks, markRead, dismiss })
}
