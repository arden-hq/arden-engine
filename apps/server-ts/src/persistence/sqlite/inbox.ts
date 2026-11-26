import { INBOX_ITEM_LIMIT } from "@arden-hq/protocol/inbox"
import { blockedSpaceGroups, blockedTaskEntries, group, type TaskRow } from "./inbox-blocked.js"
import { DateTime, Effect } from "effect"
import { planLimitEntries } from "./inbox-plan-limit.js"
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
  type InboxState
} from "../inbox/store.js"
import type { PersistenceDeps } from "./deps.js"
import { automationFailureEntries, timeValue, unread } from "./inbox-failures.js"
import { makeOpenAsksLoader, makeSnapshotLoader } from "./inbox-loaders.js"
import {
  FAILURE_WINDOW_DAYS,
  type Projection,
  type Snapshot,
  type StoreOperation,
  abandonedDeliveryCause,
  approvalKey,
  byRecency,
  capGroups,
  storeError
} from "./inbox-rows.js"

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
