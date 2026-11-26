import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  eventItemIds,
  screenedBatch,
  type BatchedEvent,
  type EventBatch
} from "../automations/event-batch.js"
import { renderEvents } from "../automations/event-text.js"
import {
  AutomationStoreError,
  type AutomationEventScreen,
  type AutomationEventScreenOutcome,
  type StoredAutomationRunSkip
} from "../automations/store.js"
import { eventBatchOf } from "./automation-listening.js"
import { claimedWork } from "./automation-claimed-work.js"
import { storeError, type AutomationStoreDeps } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { skipEnd } from "./automation-skip-record.js"
import { endAutomationRun } from "./automation-run-outcome.js"
import { textOptions, eventKeyOf } from "./automation-event-batch.js"
import { encodeQueueContext } from "./automation-queue-context.js"
import { makeFencedOccurrences } from "./automation-fenced-occurrence.js"

export interface EventScreens {
  readonly recordEventScreen: (input: {
    readonly lease: { readonly id: string; readonly token: string }
    readonly screen: AutomationEventScreen
    readonly now: number
  }) => Effect.Effect<AutomationEventScreenOutcome, AutomationStoreError>
}

export const makeEventScreens = (
  deps: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">
): EventScreens => {
  const { writer } = deps
  const sql = writer.sql
  const { loadFenced } = makeFencedOccurrences(deps)
  const recordEventScreen = Effect.fn("SqliteAutomationStore.recordEventScreen")(function* (input: {
    readonly lease: { readonly id: string; readonly token: string }
    readonly screen: AutomationEventScreen
    readonly now: number
  }): Effect.fn.Return<AutomationEventScreenOutcome, AutomationStoreError> {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const fenced = yield* loadFenced(input.lease, "record_skips", input.now)
          const batch = eventBatchOf(fenced.context)
          const [first, ...later] = input.screen.skipped
          if (batch === undefined || first === undefined)
            return yield* storeError(
              "record_skips",
              "invalid",
              "Only a screened event wake records skips",
              fenced.queue.task_id
            )
          const ran = screenedBatch(batch, new Set(input.screen.passed), eventKeyOf)
          const allSkipped = ran === undefined
          const recorded = allSkipped ? later : input.screen.skipped
          const byKey = new Map(batch.events.map((event) => [eventKeyOf(event), event]))
          for (const skipped of recorded) {
            const event = byKey.get(skipped.key)
            if (event !== undefined)
              yield* insertSkip(
                sql,
                fenced.parsed.runId,
                skipped.key,
                event,
                skipped.skip,
                input.now
              )
          }
          const settled = batch.events.find((event) => eventKeyOf(event) === first.key)
          const screened =
            ran ??
            (settled === undefined
              ? undefined
              : ({ events: [settled], overflow: [], omitted: batch.omitted } satisfies EventBatch))
          if (screened === undefined)
            return yield* storeError(
              "record_skips",
              "invalid",
              "A screened event wake kept no event",
              fenced.queue.task_id
            )
          const { run_only_if: _top, ...context } = fenced.context
          const triggerContext = renderEvents(
            screened,
            textOptions(
              fenced.context,
              input.now,
              fenced.owner === undefined ? null : claimedWork(fenced.owner).cooldownMinutes
            )
          )
          const encoded = yield* encodeQueueContext(
            {
              ...context,
              event_batch: screened,
              trigger_context: triggerContext
            },
            "record_skips",
            fenced.queue.task_id
          )
          yield* sql`UPDATE automation_event_queue SET context = ${encoded} WHERE id = ${fenced.parsed.queueId}`
          return allSkipped
            ? ({ kind: "skip", skip: first.skip } as const)
            : ({ kind: "run", triggerContext, itemIds: eventItemIds(screened) } as const)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "record_skips",
                "storage",
                "Could not record the skipped events",
                undefined,
                cause
              )
        )
      )
  })
  return { recordEventScreen }
}

const insertSkip = Effect.fn("AutomationEventBatch.insertSkip")(function* (
  sql: SqlClient.SqlClient,
  runId: number,
  key: string,
  event: BatchedEvent,
  skip: StoredAutomationRunSkip,
  now: number
) {
  const { run_only_if: _sentences, ...cause } = event
  const at = iso(now)
  const inserted = yield* sql<{ readonly id: number }>`INSERT INTO automation_runs (
      task_id, automation_ref, started_at, status, origin, item_id, task_generation, purpose,
      handler, context_mode, trigger_json, claim_count, instruction_revision_id
    )
    SELECT task_id, automation_ref, ${at}, 'running',
      json_set(origin, '$.occurrence_id', json_extract(origin, '$.occurrence_id') || '#' || ${key}),
      item_id, task_generation, purpose, handler, context_mode,
      ${JSON.stringify({ source: "event", ...cause })}, 0, instruction_revision_id
    FROM automation_runs WHERE id = ${runId}
    RETURNING id`
  const entry = inserted[0]
  if (entry === undefined) return
  yield* endAutomationRun(sql, {
    id: entry.id,
    ...skipEnd(skip),
    endedAt: at,
    error: null,
    chatRunId: null,
    chatSessionId: null,
    skip
  })
})
