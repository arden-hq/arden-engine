import {
  DEFAULT_LIMIT_SETTINGS,
  type LimitSettings,
  type LimitSettingsPatch
} from "@arden-hq/protocol/settings"
import {
  LimitSettingsDocumentPatchSchema,
  LimitSettingsSchema
} from "@arden-hq/protocol/effect/settings"
import { DateTime, Effect, PubSub, Stream } from "effect"
import type { PlanLimitNotice } from "../../models/plan-limits.js"

import { LimitSettingsStore, LimitSettingsStoreError } from "../settings/store.js"
import type { PersistenceDeps } from "./deps.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { UnitOfWork } from "../unit-of-work.js"
import { releaseQuotaPauses } from "./plan-quota.js"
import { makeSettingsDocument } from "./settings-document.js"

export const NOTICE_NAMESPACE = "plan_limit_notice"

export const makeLimitSettingsStore = Effect.fn("SqliteLimitSettingsStore.make")(function* ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer"> & {
  readonly sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendEventInTransaction">
}) {
  const document = yield* makeSettingsDocument({
    writer,
    namespace: "limit_settings",
    label: "limit settings",
    schema: LimitSettingsSchema,
    patchSchema: LimitSettingsDocumentPatchSchema,
    defaults: DEFAULT_LIMIT_SETTINGS,
    error: LimitSettingsStoreError
  })
  const changed = yield* PubSub.unbounded<LimitSettings>()
  const updateSettings = Effect.fn("SqliteLimitSettingsStore.updateSettings")(function* (
    patch: LimitSettingsPatch
  ) {
    const { automationLimit, ...rest } = patch
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const settings = yield* document.updateInTransaction((current) => {
            if (automationLimit === undefined) return rest
            const { automationId, ...limit } = automationLimit
            const { [automationId]: _previous, ...others } = current.automationLimits
            const cleared = limit.pauseAtPercent === null && limit.maxTokensPerRun === null
            return {
              ...rest,
              automationLimits: cleared ? others : { ...others, [automationId]: limit }
            }
          })
          yield* releaseQuotaPauses(writer.sql)
          const unit = yield* UnitOfWork
          yield* unit.afterCommit(PubSub.publish(changed, settings).pipe(Effect.asVoid))
          return settings
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof LimitSettingsStoreError
            ? cause
            : new LimitSettingsStoreError({
                operation: "update_settings",
                reason: "storage",
                message: "Could not update limits and release paused runs",
                cause
              })
        )
      )
  })
  const recordNotice = Effect.fn("SqliteLimitSettingsStore.recordNotice")(function* (
    notice: PlanLimitNotice | undefined
  ) {
    const sql = writer.sql
    const now = DateTime.formatIso(yield* DateTime.now)
    yield* writer
      .transact(
        Effect.gen(function* () {
          if (notice === undefined) {
            yield* sql`DELETE FROM monitor_state WHERE namespace = ${NOTICE_NAMESPACE}`
            return
          }
          const rows = yield* sql<{
            readonly state: string
            readonly level: string
            readonly resets_at: string
            readonly since: string
          }>`
            SELECT state, json_extract(state, '$.level') AS level,
                   json_extract(state, '$.resetsAt') AS resets_at,
                   json_extract(state, '$.since') AS since
            FROM monitor_state WHERE namespace = ${NOTICE_NAMESPACE}`
          const previous = rows[0]
          const crossed =
            previous === undefined ||
            previous.level !== notice.level ||
            previous.resets_at !== notice.resetsAt
          const state = JSON.stringify({ ...notice, since: crossed ? now : previous.since })
          if (state === previous?.state) return
          if (crossed) {
            yield* sessionEvents.appendEventInTransaction({
              type: "limit_crossed",
              level: notice.level,
              used_percent: notice.usedPercent,
              limit_percent: notice.limitPercent,
              window_seconds: notice.windowSeconds,
              resets_at: notice.resetsAt,
              produced_by: null,
              chain_depth: 0
            })
          }
          yield* sql`
            INSERT INTO monitor_state (namespace, state, updated_at)
            VALUES (${NOTICE_NAMESPACE}, ${state}, ${now})
            ON CONFLICT(namespace) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
        })
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new LimitSettingsStoreError({
              operation: "update_settings",
              reason: "storage",
              message: "Could not record the plan limit notice",
              cause
            })
        )
      )
  })
  return LimitSettingsStore.of({
    settings: document.read,
    updateSettings,
    changes: Stream.fromPubSub(changed),
    recheckPausedRuns: () =>
      writer.transact(releaseQuotaPauses(writer.sql, { reason: "plan_used_up" })).pipe(
        Effect.mapError(
          (cause) =>
            new LimitSettingsStoreError({
              operation: "update_settings",
              reason: "storage",
              message: "Could not recheck runs paused on a plan limit",
              cause
            })
        )
      ),
    recordNotice
  })
})
