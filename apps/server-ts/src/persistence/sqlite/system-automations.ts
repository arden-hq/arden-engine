import { JOB_PURPOSE } from "../job-classification.js"
import { Clock, Effect } from "effect"

import {
  SYSTEM_PROMPT_EDIT,
  SYSTEM_TRIGGER_SCOPE,
  TRIGGERS_SOURCE,
  type TriggersSource,
  type AutomationRules,
  type PersonalAutomationTriggers,
  type SystemAutomationSpec
} from "../automations/model.js"

import { AutomationStoreError } from "../automations/store.js"
import { namedPublicRef } from "../public-ref.js"
import { nextId } from "./deps.js"
import type { PersistenceDeps } from "./deps.js"
import {
  AutomationTriggersSchema,
  listenerTriggers,
  scheduleEffect
} from "./automation-schedule.js"
import { freshTriggerIds } from "@arden-hq/protocol/automations"
import { encodeJson } from "./json.js"
import { systemTakesTrigger } from "../automations/system-settings.js"
import { insertSession } from "./session-insert.js"
import { haltAutomation } from "./automation-halt.js"
import { resumeOnTriggers } from "./automation-resume.js"
import { renameOwnedJob } from "./job-labels.js"
import { iso } from "../../runtime/clock.js"

const SYSTEM_SESSION = { chat: "chat", none: "none" } as const

type SystemSession =
  | { readonly kind: typeof SYSTEM_SESSION.chat; readonly id: string; readonly create: boolean }
  | { readonly kind: typeof SYSTEM_SESSION.none; readonly id: null; readonly create: false }

interface StoredSystemAutomation {
  readonly task_id: string
  readonly enabled: number
  readonly purpose: string
  readonly triggers: string
  readonly triggers_source: TriggersSource | null
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly thread_id: string | null
  readonly auto_resume_at: string | null
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
  if (input.row.triggers_source === TRIGGERS_SOURCE.manual) return input.row.next_run_at
  const parsed = input.row.last_run_at === null ? input.nowMs : Date.parse(input.row.last_run_at)
  const next = scheduledAt(
    input.rules,
    input.schedule,
    Number.isFinite(parsed) ? parsed : input.nowMs
  )
  if (next === null) return null
  return input.row.next_run_at !== null && !input.spec.rearmOnSeed ? input.row.next_run_at : next
}

const OWNER_TRIGGERS_KIND = { spec: "spec", owner: "owner", noneTaken: "none_taken" } as const

type OwnerTriggers =
  | { readonly kind: typeof OWNER_TRIGGERS_KIND.spec }
  | { readonly kind: typeof OWNER_TRIGGERS_KIND.owner; readonly triggers: string }
  | { readonly kind: typeof OWNER_TRIGGERS_KIND.noneTaken }

const ownerTriggers = Effect.fn("SqliteAutomationStore.ownerTriggers")(function* (
  spec: SystemAutomationSpec,
  row: StoredSystemAutomation
): Effect.fn.Return<OwnerTriggers, AutomationStoreError> {
  if (row.triggers_source !== TRIGGERS_SOURCE.manual) return { kind: OWNER_TRIGGERS_KIND.spec }
  const kept: OwnerTriggers = { kind: OWNER_TRIGGERS_KIND.owner, triggers: row.triggers }
  if (spec.triggerScope === SYSTEM_TRIGGER_SCOPE.any) return kept
  const stored = yield* listenerTriggers({ task_id: spec.automationId, triggers: row.triggers })
  if (stored === undefined) return kept
  const taken = stored.filter((trigger) => systemTakesTrigger(spec, trigger))
  if (taken.length === 0) return { kind: OWNER_TRIGGERS_KIND.noneTaken }
  if (taken.length === stored.length) return kept
  return {
    kind: OWNER_TRIGGERS_KIND.owner,
    triggers: yield* encodeJson(AutomationTriggersSchema, taken).pipe(
      Effect.mapError((cause) =>
        seedError("Could not encode the system Automation triggers", spec.automationId, cause)
      )
    )
  }
})

const storedTriggers = (owner: OwnerTriggers, specTriggers: string): string => {
  switch (owner.kind) {
    case OWNER_TRIGGERS_KIND.spec:
      return specTriggers
    case OWNER_TRIGGERS_KIND.owner:
      return owner.triggers
    case OWNER_TRIGGERS_KIND.noneTaken:
      return "[]"
  }
}

export const specSchedule = Effect.fn("SqliteAutomationStore.specSchedule")(function* (
  rules: AutomationRules["Service"],
  spec: SystemAutomationSpec,
  operation: "seed_builtin" | "update"
) {
  const written = freshTriggerIds(spec.triggers)
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
                       last_run_at, next_run_at, thread_id, auto_resume_at
                FROM scheduled_tasks
                WHERE task_id = ${spec.automationId}
                LIMIT 1
              `
            const row = rows[0]
            if (row !== undefined && row.purpose !== JOB_PURPOSE.system) {
              return yield* new AutomationStoreError({
                operation: "seed_builtin",
                reason: "conflict",
                message: "A system Automation id belongs to another current owner",
                automationId: spec.automationId
              })
            }

            const session: SystemSession = spec.chatSession
              ? {
                  kind: SYSTEM_SESSION.chat,
                  id: row?.thread_id ?? (yield* nextId),
                  create: row === undefined || row.thread_id === null
                }
              : { kind: SYSTEM_SESSION.none, id: null, create: false }
            if (session.kind === SYSTEM_SESSION.chat && session.create) {
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
                    next_run_at, last_result, auto_approve, handler,
                    builtin, cooldown_minutes, thread_id, purpose,
                    idempotency_key, idempotency_scope, tool_scope, triggers_source
                  ) VALUES (
                    ${spec.automationId}, ${namedPublicRef(spec.name, spec.automationId)}, ${spec.name},
                    ${spec.description}, 'manual', ${spec.prompt}, NULL, ${spec.contextMode}, ${triggers},
                    ${lastId}, ${spec.enabled ? 1 : 0}, ${createdAt(index)}, NULL, ${nextRunAt}, NULL,
                    1, ${spec.handler}, 1, ${spec.cooldownMinutes}, ${session.id}, 'system',
                    NULL, NULL, ${spec.toolScope}, NULL
                  )
                `
              continue
            }

            const owner = yield* ownerTriggers(spec, row)
            const noneTaken = owner.kind === OWNER_TRIGGERS_KIND.noneTaken
            const stored = storedTriggers(owner, triggers)
            const userOwnsTriggers = stored !== triggers
            const resumes =
              !noneTaken && spec.enabled && row.enabled === 0 && row.auto_resume_at !== null
            const enabled = !noneTaken && spec.enabled && (row.enabled === 1 || resumes)
            const fixed = spec.promptEdit === SYSTEM_PROMPT_EDIT.fixed ? 1 : 0
            const current = {
              ...row,
              triggers_source: userOwnsTriggers ? TRIGGERS_SOURCE.manual : null,
              next_run_at: userOwnsTriggers && stored !== row.triggers ? null : row.next_run_at
            }
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
                SET description = ${spec.description},
                    description_source = 'manual',
                    prompt = CASE WHEN prompt_author IS NULL OR ${fixed} THEN ${spec.prompt}
                      ELSE prompt END,
                    prompt_author = CASE WHEN ${fixed} THEN NULL ELSE prompt_author END,
                    context_mode = ${spec.contextMode},
                    handler = ${spec.handler},
                    builtin = 1,
                    cooldown_minutes = ${spec.cooldownMinutes},
                    tool_scope = ${spec.toolScope},
                    thread_id = ${session.id},
                    enabled = ${enabled ? 1 : 0},
                    triggers = ${stored},
                    trigger_last_id = MAX(trigger_last_id, ${lastId}),
                    triggers_source = ${current.triggers_source},
                    next_run_at = ${nextRunAt}
                WHERE task_id = ${spec.automationId}
              `
            yield* renameOwnedJob(sql, spec.automationId, spec.name)
            if (resumes)
              yield* resumeOnTriggers({
                sql,
                rules,
                row: {
                  task_id: spec.automationId,
                  triggers: stored
                },
                now: timestamp
              })
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
