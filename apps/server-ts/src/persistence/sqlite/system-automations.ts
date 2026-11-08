import { Clock, Effect } from "effect"

import type {
  AutomationRules,
  PersonalAutomationTriggers,
  SystemAutomationSpec
} from "../automations/model.js"
import { AutomationStoreError } from "../automations/store.js"
import { namedPublicRef } from "../public-ref.js"
import { nextId } from "./deps.js"
import type { PersistenceDeps } from "./deps.js"
import { AutomationTriggersSchema, scheduleEffect, writtenTriggers } from "./automation-schedule.js"
import { encodeJson } from "./json.js"
import { insertSession } from "./session-insert.js"
import { haltAutomation } from "./automation-halt.js"
import { iso } from "../../runtime/clock.js"

interface StoredSystemAutomation {
  readonly task_id: string
  readonly enabled: number
  readonly purpose: string
  readonly triggers: string
  readonly triggers_source: string | null
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly thread_id: string | null
}

const seedError = (message: string, automationId: string | undefined, cause?: unknown) =>
  new AutomationStoreError({
    operation: "seed_builtin",
    reason: "storage",
    message,
    ...(automationId === undefined ? {} : { automationId }),
    ...(cause === undefined ? {} : { cause })
  })

const scheduledAt = (
  rules: AutomationRules["Service"],
  schedule: PersonalAutomationTriggers,
  anchorMs: number
): string | null => {
  const next = rules.nextRunAt(schedule, anchorMs)
  return next === null || !Number.isFinite(next) ? null : iso(next)
}

const currentNextRunAt = (input: {
  readonly rules: AutomationRules["Service"]
  readonly spec: SystemAutomationSpec
  readonly schedule: PersonalAutomationTriggers
  readonly row: StoredSystemAutomation
  readonly enabled: boolean
  readonly nowMs: number
}): string | null => {
  if (!input.enabled) return null
  if (input.row.triggers_source === "manual") return input.row.next_run_at
  if (input.row.next_run_at !== null && !input.spec.rearmOnSeed) return input.row.next_run_at
  const parsed = input.row.last_run_at === null ? input.nowMs : Date.parse(input.row.last_run_at)
  return scheduledAt(input.rules, input.schedule, Number.isFinite(parsed) ? parsed : input.nowMs)
}

export const specSchedule = Effect.fn("SqliteAutomationStore.specSchedule")(function* (
  rules: AutomationRules["Service"],
  spec: SystemAutomationSpec,
  operation: "seed_builtin" | "update"
) {
  const written = yield* writtenTriggers("new", spec.triggers, operation, spec.automationId)
  const schedule = yield* scheduleEffect(rules, written.triggers, operation, spec.automationId)
  const triggers = yield* encodeJson(AutomationTriggersSchema, schedule.triggers).pipe(
    Effect.mapError(
      (cause) =>
        new AutomationStoreError({
          operation,
          reason: "storage",
          message: "Could not encode the system Automation triggers",
          automationId: spec.automationId,
          cause
        })
    )
  )
  return { spec, schedule, triggers, lastId: written.lastId }
})

export const seedSystemAutomations = Effect.fn("SqliteAutomationStore.seedSystemAutomations")(
  function* ({
    writer,
    sessionEvents,
    rules,
    specs
  }: Pick<PersistenceDeps, "writer" | "sessionEvents"> & {
    readonly rules: AutomationRules["Service"]
    readonly specs: ReadonlyArray<SystemAutomationSpec>
  }): Effect.fn.Return<void, AutomationStoreError> {
    const sql = writer.sql
    const schedules = yield* Effect.forEach(specs, (spec) =>
      specSchedule(rules, spec, "seed_builtin")
    )
    yield* writer
      .transact(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const timestamp = iso(nowMs)
          const createdAt = (index: number) => iso(nowMs + index)

          for (const [index, { spec, schedule, triggers, lastId }] of schedules.entries()) {
            const rows = yield* sql<StoredSystemAutomation>`
                SELECT task_id, enabled, purpose, triggers, triggers_source,
                       last_run_at, next_run_at, thread_id
                FROM scheduled_tasks
                WHERE task_id = ${spec.automationId}
                LIMIT 1
              `
            const row = rows[0]
            if (row !== undefined && row.purpose !== "system") {
              return yield* new AutomationStoreError({
                operation: "seed_builtin",
                reason: "conflict",
                message: "A system Automation id belongs to another current owner",
                automationId: spec.automationId
              })
            }

            const session = spec.chatSession
              ? {
                  kind: "chat" as const,
                  id: row?.thread_id ?? (yield* nextId),
                  create: row === undefined || row.thread_id === null
                }
              : { kind: "none" as const, id: null, create: false }
            if (session.kind === "chat" && session.create) {
              yield* insertSession({
                sql,
                session: {
                  type: "channel",
                  sessionId: session.id,
                  publicRef: namedPublicRef(spec.name, session.id),
                  startedAt: timestamp,
                  name: spec.name,
                  metadata: "{}",
                  spaceId: null,
                  chatModel: null,
                  originAutomationId: spec.automationId
                },
                lifecycle: { kind: "announce", events: sessionEvents, complete: Effect.void }
              })
            }

            if (row === undefined) {
              const nextRunAt = spec.enabled ? scheduledAt(rules, schedule, nowMs) : null
              yield* sql`
                  INSERT INTO scheduled_tasks (
                    task_id, automation_ref, name, description, description_source,
                    prompt, model, context_mode, triggers, trigger_last_id, enabled, created_at, last_run_at,
                    next_run_at, last_result, running_since, auto_approve, handler,
                    builtin, cooldown_minutes, thread_id, purpose,
                    idempotency_key, idempotency_scope, tool_scope, triggers_source
                  ) VALUES (
                    ${spec.automationId}, ${namedPublicRef(spec.name, spec.automationId)}, ${spec.name},
                    ${spec.description}, 'manual', ${spec.prompt}, NULL, ${spec.contextMode}, ${triggers},
                    ${lastId}, ${spec.enabled ? 1 : 0}, ${createdAt(index)}, NULL, ${nextRunAt}, NULL, NULL,
                    1, ${spec.handler}, 1, ${spec.cooldownMinutes}, ${session.id}, 'system',
                    NULL, NULL, ${spec.toolScope}, NULL
                  )
                `
              continue
            }

            const enabled = spec.enabled && row.enabled === 1
            const userOwnsTriggers = row.triggers_source === "manual" && row.triggers !== triggers
            const current = { ...row, triggers_source: userOwnsTriggers ? "manual" : null }
            const nextRunAt = currentNextRunAt({
              rules,
              spec,
              schedule,
              row: current,
              enabled,
              nowMs
            })
            yield* sql`
                UPDATE scheduled_tasks
                SET name = ${spec.name},
                    description = ${spec.description},
                    description_source = 'manual',
                    prompt = CASE WHEN prompt_author IS NULL THEN ${spec.prompt} ELSE prompt END,
                    context_mode = ${spec.contextMode},
                    handler = ${spec.handler},
                    builtin = 1,
                    cooldown_minutes = ${spec.cooldownMinutes},
                    tool_scope = ${spec.toolScope},
                    thread_id = ${session.id},
                    enabled = ${enabled ? 1 : 0},
                    triggers = ${userOwnsTriggers ? row.triggers : triggers},
                    trigger_last_id = MAX(trigger_last_id, ${lastId}),
                    triggers_source = ${current.triggers_source},
                    next_run_at = ${nextRunAt}
                WHERE task_id = ${spec.automationId}
              `
            if (!enabled && row.enabled === 1)
              yield* haltAutomation({
                sql,
                sessionEvents,
                automationId: spec.automationId,
                halt: "stop"
              })
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : seedError("Could not seed current system Automations", undefined, cause)
        )
      )
  }
)
