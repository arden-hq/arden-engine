import { captureMutationVersions } from "./mutation-links.js"
import { haltAutomation } from "./automation-halt.js"
import type {
  Automation,
  AutomationChatChoice,
  AutomationContextMode,
  AutomationHistory,
  SystemAutomationSetting
} from "@arden-hq/protocol/automations"
import {
  InternalCreateAutomationRequestSchema,
  UpdateAutomationInputSchema
} from "@arden-hq/protocol/effect/automations"
import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { AutomationRules, PersonalAutomationTriggers } from "../automations/model.js"
import { AutomationCatalog, type PromptWriter } from "../automations/catalog.js"
import { AutomationStoreError } from "../automations/store.js"
import { isSpaceWorkJob, isUserAutomationPurpose, type JobPurpose } from "../job-classification.js"
import { namedPublicRef } from "../public-ref.js"
import { decodeJson, encodeJson } from "./json.js"
import {
  AutomationTriggersSchema,
  sameTriggers,
  scheduleEffect,
  writtenTriggers
} from "./automation-schedule.js"
import { resumeAutomation } from "./automation-resume.js"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"
import { nextId } from "./deps.js"
import { insertOwnChat, ownChat } from "./automation-own-chat.js"
import {
  makeAutomationRowReads,
  type AutomationRow,
  type AutomationStoreDeps
} from "./automation-rows.js"
import {
  dropMeasuredRows,
  makeTriggerArming,
  rematchHeldEvents
} from "./automation-trigger-arming.js"
import { specSchedule } from "./system-automations.js"
import { strict, storeError, automationIdEffect, systemSpecOf } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import {
  lockedSystemChanges,
  lockedSystemMessage,
  systemSettable
} from "../automations/system-settings.js"
import {
  prepareInstructionRevision,
  type AutomationWriteSource
} from "./automation-instruction-provenance.js"

const updatedNextRunAt = (input: {
  readonly rules: AutomationRules["Service"]
  readonly enabled: boolean
  readonly rescheduled: boolean
  readonly schedule: Pick<PersonalAutomationTriggers, "times">
  readonly storedNextRunAt: string | null
  readonly nowMs: number
}): string | null => {
  if (!input.enabled) return null
  if (!input.rescheduled) {
    if (input.storedNextRunAt === null) return null
    const carried = Date.parse(input.storedNextRunAt)
    return Number.isFinite(carried) ? iso(carried) : null
  }
  const next = input.rules.nextRunAt(input.schedule, input.nowMs)
  if (next === null || !Number.isFinite(next)) return null
  return iso(next)
}

export const makeAutomationCatalogEdits = ({
  writer,
  sessionEvents,
  rules
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">): Pick<
  AutomationCatalog["Service"],
  "create" | "update" | "resetSystemSetting"
> => {
  const sql = writer.sql
  const { findAutomationRow, get } = makeAutomationRowReads({ writer, rules })
  const { rearmAutomation } = makeTriggerArming({ writer, sessionEvents })

  const chosenThread = Effect.fn("SqliteAutomationStore.chosenThread")(function* (
    chat: AutomationChatChoice,
    row: AutomationRow,
    automationId: string,
    mutation: AutomationWriteSource | undefined
  ) {
    if (chat.kind === "yours") {
      yield* requireUserChat(sql, chat.session_id, "update", automationId)
      return chat.session_id
    }
    if (row.thread_origin_automation_id === automationId && row.thread_id !== null) {
      return row.thread_id
    }
    return yield* ownChat({
      sql,
      sessionEvents,
      automationId,
      name: row.name,
      model: row.model,
      mutation
    })
  })
  const create = Effect.fn("SqliteAutomationStore.create")(function* (
    input,
    promptWriter: PromptWriter,
    source?: AutomationWriteSource
  ) {
    const valid = yield* Schema.decodeUnknownEffect(InternalCreateAutomationRequestSchema)(
      input,
      strict
    ).pipe(
      Effect.mapError((cause) =>
        storeError("create", "invalid", "Invalid Automation request", undefined, cause)
      )
    )
    const chat = valid.chat ?? { kind: "own" as const }
    const model = yield* setupModel({
      chat: chat.kind,
      history: valid.history,
      requested: valid.model,
      stored: null,
      operation: "create"
    })
    const written = yield* writtenTriggers("new", valid.triggers, "create")
    const schedule = yield* scheduleEffect(rules, written.triggers, "create")
    const automationId = `automation:${yield* nextId}`
    const ownChatId = yield* nextId
    const nowMs = yield* Clock.currentTimeMillis
    const timestamp = iso(nowMs)
    const enabled = valid.enabled !== false
    const nextRun = enabled ? rules.nextRunAt(schedule, nowMs) : null
    const triggersJson = yield* encodeJson(AutomationTriggersSchema, schedule.triggers).pipe(
      Effect.mapError((cause) =>
        storeError("create", "storage", "Could not encode Automation triggers", undefined, cause)
      )
    )
    const createdAutomationId = yield* writer
      .transact(
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly task_id: string }>`
          SELECT task_id FROM scheduled_tasks
          WHERE idempotency_scope = 'global' AND idempotency_key = ${valid.idempotency_key}
          ORDER BY created_at, task_id
          LIMIT 1
        `
          if (existing[0] !== undefined) {
            return existing[0].task_id
          }
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "automation",
            id: automationId,
            identity: source
          })
          const recordChat = yield* captureMutationVersions(sql, {
            domain: "session",
            id: ownChatId,
            identity: source
          })
          const threadId = chat.kind === "yours" ? chat.session_id : ownChatId
          if (chat.kind === "yours") yield* requireUserChat(sql, chat.session_id, "create")
          const instructionRevisionId = yield* prepareInstructionRevision(sql, {
            automationId,
            instruction: {
              prompt: valid.prompt,
              model,
              context_mode: historyContextMode(valid.history),
              triggers: triggersJson,
              thread_id: threadId,
              cooldown_minutes: valid.cooldown_minutes ?? null
            },
            previousRevisionId: null,
            promptAuthor: promptWriter,
            source,
            toolName: "automation_create",
            writtenAt: timestamp
          })
          const insertAutomation = sql`
          INSERT INTO scheduled_tasks (
            task_id, automation_ref, name, description, description_source,
            prompt, model, context_mode, triggers, trigger_last_id, enabled, created_at, last_run_at,
            next_run_at, last_result, running_since, auto_approve, handler,
            builtin, cooldown_minutes, thread_id, idempotency_key, idempotency_scope,
            tool_scope, triggers_source, purpose, prompt_author, instruction_revision_id
          ) VALUES (
            ${automationId}, ${namedPublicRef(valid.name, automationId)}, ${valid.name},
            ${valid.description ?? null}, ${valid.description === undefined ? null : "manual"},
            ${valid.prompt}, ${model}, ${historyContextMode(valid.history)}, ${triggersJson},
            ${written.lastId}, ${enabled ? 1 : 0}, ${timestamp}, NULL, ${nextRun === null ? null : iso(nextRun)},
            NULL, NULL, 0, NULL, 0, ${valid.cooldown_minutes ?? null},
            ${threadId},
            ${valid.idempotency_key}, 'global', 'all', 'manual', 'user_automation', ${promptWriter},
            ${instructionRevisionId}
          )
        `
          if (chat.kind === "yours" && valid.history === "chat") {
            yield* insertAutomation
          } else {
            yield* insertOwnChat({
              sql,
              sessionEvents,
              automationId,
              sessionId: ownChatId,
              name: valid.name,
              model,
              approvalMode: valid.approval_mode ?? DEFAULT_APPROVAL_MODE,
              startedAt: timestamp,
              complete: insertAutomation
            })
          }
          yield* recordVersions
          yield* recordChat
          return automationId
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError("create", "storage", "Could not create Automation", undefined, cause)
        )
      )
    const created = yield* get(createdAutomationId)
    return (
      created ??
      (yield* storeError(
        "create",
        "corrupt",
        "Created Automation could not be loaded",
        createdAutomationId
      ))
    )
  })

  const update = Effect.fn("SqliteAutomationStore.update")(function* (
    automationId: string,
    input,
    promptWriter: PromptWriter,
    source?: AutomationWriteSource
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "update")
    const valid = yield* Schema.decodeUnknownEffect(UpdateAutomationInputSchema)(
      input,
      strict
    ).pipe(
      Effect.mapError((cause) =>
        storeError("update", "invalid", "Invalid Automation update", validAutomationId, cause)
      )
    )
    const updatedAutomationId = yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "automation",
            id: validAutomationId,
            identity: source
          })
          const ownedChats = yield* sql<{
            readonly session_id: string
          }>`SELECT session_id FROM sessions WHERE origin_automation_id = ${validAutomationId}`
          const recordChats = yield* Effect.forEach(ownedChats, (chat) =>
            captureMutationVersions(sql, {
              domain: "session",
              id: chat.session_id,
              identity: source
            })
          )
          const row = yield* findAutomationRow(validAutomationId, "update")
          if (row === null) return null
          const spec = row.purpose === "system" ? yield* systemSpecOf(rules, row, "update") : null
          if (spec !== null) {
            const locked = lockedSystemChanges(row, valid, spec)
            if (locked.length > 0) {
              return yield* storeError(
                "update",
                "invalid",
                lockedSystemMessage(locked, spec),
                validAutomationId
              )
            }
          }
          const threadId =
            valid.chat === undefined
              ? row.thread_id
              : yield* chosenThread(valid.chat, row, validAutomationId, source)
          const threadChanged = threadId !== row.thread_id
          if (threadChanged) {
            if (
              row.running_since !== null ||
              (yield* sql`
                SELECT 1 FROM automation_runs WHERE task_id = ${validAutomationId} AND status = 'running' LIMIT 1
              `).length > 0
            ) {
              return yield* storeError(
                "update",
                "conflict",
                "Wait for the current Automation run before changing its chat",
                validAutomationId
              )
            }
          }
          const history = valid.history ?? (spec === null ? contextHistory(row.context_mode) : null)
          const systemModel = valid.model === undefined ? row.model : valid.model
          const chatKind =
            valid.chat?.kind ??
            (row.thread_origin_automation_id === validAutomationId ? "own" : "yours")
          const model =
            history === null
              ? systemModel
              : yield* setupModel({
                  chat: chatKind,
                  history,
                  requested: valid.model,
                  stored: row.model,
                  operation: "update",
                  automationId: validAutomationId
                })
          if (chatKind === "yours" && history === "fresh") {
            yield* ownChat({
              sql,
              sessionEvents,
              automationId: validAutomationId,
              name: valid.name ?? row.name,
              model,
              mutation: source
            })
          }
          const currentTriggers = yield* decodeJson(AutomationTriggersSchema, row.triggers).pipe(
            Effect.mapError((cause) =>
              storeError(
                "update",
                "corrupt",
                "Stored Automation triggers are corrupt",
                validAutomationId,
                cause
              )
            )
          )
          const stored = { triggers: currentTriggers, lastId: row.trigger_last_id }
          const written =
            valid.triggers === undefined
              ? stored
              : yield* writtenTriggers(stored, valid.triggers, "update", validAutomationId)
          const schedule = yield* scheduleEffect(
            rules,
            written.triggers,
            "update",
            validAutomationId
          )
          if (spec !== null) yield* refuseSystemRunOnlyIf(schedule.triggers, validAutomationId)
          const triggersJson =
            valid.triggers === undefined
              ? row.triggers
              : yield* encodeJson(AutomationTriggersSchema, schedule.triggers).pipe(
                  Effect.mapError((cause) =>
                    storeError(
                      "update",
                      "storage",
                      "Could not encode Automation triggers",
                      validAutomationId,
                      cause
                    )
                  )
                )
          let triggersSource = row.triggers_source
          if (valid.triggers !== undefined) {
            const pickedDefault =
              spec !== null &&
              sameTriggers(
                schedule.triggers,
                (yield* specSchedule(rules, spec, "update")).schedule.triggers
              )
            triggersSource = pickedDefault ? null : "manual"
          }
          const enabled = valid.enabled ?? row.enabled === 1
          if (enabled && row.enabled === 0 && threadId !== null) {
            const archivedSpace = yield* sql`
              SELECT 1 FROM sessions AS chat JOIN spaces AS space ON space.space_id = chat.space_id
              WHERE chat.session_id = ${threadId} AND space.archived_at IS NOT NULL LIMIT 1`
            if (archivedSpace.length > 0) {
              return yield* storeError(
                "update",
                "conflict",
                "Its chat's Space is archived. Restore the Space to resume it",
                validAutomationId
              )
            }
          }
          const rescheduled =
            valid.triggers !== undefined || (valid.enabled === true && row.enabled === 0)
          const nextRunAt = updatedNextRunAt({
            rules,
            enabled,
            rescheduled,
            schedule,
            storedNextRunAt: row.next_run_at,
            nowMs: yield* Clock.currentTimeMillis
          })
          const name = valid.name ?? row.name
          const promptRewritten = valid.prompt !== undefined && valid.prompt !== row.prompt
          let promptAuthor = promptRewritten ? promptWriter : row.prompt_author
          if (spec !== null && valid.prompt === spec.prompt) promptAuthor = null
          const cooldownMinutes =
            valid.cooldown_minutes === undefined ? row.cooldown_minutes : valid.cooldown_minutes
          const instructionRevisionId =
            isUserAutomationPurpose(row.purpose) && row.builtin === 0
              ? yield* prepareInstructionRevision(sql, {
                  automationId: validAutomationId,
                  instruction: {
                    prompt: valid.prompt ?? row.prompt,
                    model,
                    context_mode: history === null ? row.context_mode : historyContextMode(history),
                    triggers: triggersJson,
                    thread_id: threadId,
                    cooldown_minutes: cooldownMinutes
                  },
                  previousRevisionId: row.instruction_revision_id,
                  promptAuthor,
                  source,
                  toolName: "automation_update",
                  writtenAt: iso(yield* Clock.currentTimeMillis)
                })
              : row.instruction_revision_id
          yield* sql`
          UPDATE scheduled_tasks
          SET followup_generation = followup_generation + 1, name = ${name},
              description = ${valid.description ?? row.description},
              description_source = ${valid.description === undefined ? row.description_source : "manual"},
              prompt = ${valid.prompt ?? row.prompt},
              prompt_author = ${promptAuthor},
              model = ${model},
              context_mode = ${history === null ? row.context_mode : historyContextMode(history)},
              triggers = ${triggersJson},
              trigger_last_id = ${written.lastId},
              next_run_at = ${row.enabled === 1 ? nextRunAt : null},
              cooldown_minutes = ${cooldownMinutes},
              thread_id = ${threadId},
              triggers_source = ${triggersSource},
              instruction_revision_id = ${instructionRevisionId}
          WHERE task_id = ${validAutomationId}
        `
          if (enabled && row.enabled === 0)
            yield* resumeAutomation({ sql, automationId: validAutomationId, nextRunAt })
          else if (!enabled && row.enabled === 1)
            yield* haltAutomation({
              sql,
              sessionEvents,
              automationId: validAutomationId,
              halt: "pause"
            })
          if (valid.triggers !== undefined) {
            const previous = yield* scheduleEffect(
              rules,
              currentTriggers,
              "update",
              validAutomationId
            )
            if (enabled && row.enabled === 1) yield* dropMeasuredRows(sql, validAutomationId)
            yield* rematchHeldEvents({
              sql,
              rules,
              automationId: validAutomationId,
              triggers: schedule.triggers,
              purpose: row.purpose
            })
            if (schedule.count === null || previous.count?.every_n !== schedule.count.every_n) {
              yield* sql`DELETE FROM automation_count_state WHERE task_id = ${validAutomationId}`
            }
            if (enabled && schedule.idle !== null) {
              yield* rearmAutomation(
                {
                  automationId: validAutomationId,
                  idle: schedule.idle.idle_minutes,
                  count: null,
                  chatQuiet: null
                },
                yield* Clock.currentTimeMillis
              )
            }
          }
          const currentChats = yield* sql<{
            readonly session_id: string
          }>`SELECT session_id FROM sessions WHERE origin_automation_id = ${validAutomationId}`
          const recordNewChats = yield* Effect.forEach(
            currentChats.filter(
              (chat) => !ownedChats.some((old) => old.session_id === chat.session_id)
            ),
            (chat) =>
              captureMutationVersions(sql, {
                domain: "session",
                id: chat.session_id,
                identity: source
              })
          )
          yield* sql`
            UPDATE sessions
            SET name = ${name}, chat_model = ${model}
            WHERE origin_automation_id = ${validAutomationId}
              AND session_type = 'channel'
              AND archived_at IS NULL
          `
          yield* recordVersions
          yield* Effect.all([...recordChats, ...recordNewChats])
          return validAutomationId
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "update",
                "storage",
                "Could not update Automation",
                validAutomationId,
                cause
              )
        )
      )
    if (updatedAutomationId === null) return null
    return yield* get(updatedAutomationId)
  })

  const resetSystemSetting = Effect.fn("SqliteAutomationStore.resetSystemSetting")(function* (
    automationId: string,
    setting: SystemAutomationSetting
  ): Effect.fn.Return<Automation | null, AutomationStoreError> {
    const validAutomationId = yield* automationIdEffect(automationId, "update")
    const row = yield* findAutomationRow(validAutomationId, "update")
    if (row === null) return null
    if (row.purpose !== "system") {
      return yield* storeError(
        "update",
        "invalid",
        "Only a system Automation has defaults to reset",
        validAutomationId
      )
    }
    const spec = yield* systemSpecOf(rules, row, "update")
    if (!systemSettable(spec).includes(setting))
      return yield* storeError(
        "update",
        "invalid",
        `This system Automation has no ${setting} to reset. It accepts only ${systemSettable(spec).join(", ")}.`,
        validAutomationId
      )
    switch (setting) {
      case "triggers":
        return yield* update(validAutomationId, { triggers: spec.triggers }, "agent")
      case "model":
        return yield* update(validAutomationId, { model: null }, "agent")
      case "prompt":
        return yield* update(validAutomationId, { prompt: spec.prompt }, "agent")
      case "enabled":
        return yield* update(validAutomationId, { enabled: spec.enabled }, "agent")
    }
  })

  return { create, update, resetSystemSetting }
}

const historyContextMode = (history: AutomationHistory): "fresh" | "continue" =>
  history === "chat" ? "continue" : "fresh"

const contextHistory = (contextMode: AutomationContextMode): AutomationHistory =>
  contextMode === "continue" ? "chat" : "fresh"

const setupModel = (input: {
  readonly chat: AutomationChatChoice["kind"]
  readonly history: AutomationHistory
  readonly requested: string | null | undefined
  readonly stored: string | null
  readonly operation: "create" | "update"
  readonly automationId?: string
}): Effect.Effect<string | null, AutomationStoreError> => {
  if (input.chat === "yours" && input.history === "chat") {
    return input.requested == null
      ? Effect.succeed(null)
      : Effect.fail(
          storeError(
            input.operation,
            "invalid",
            "An Automation that reads one of your chats runs on that chat's model",
            input.automationId
          )
        )
  }
  return Effect.succeed(input.requested === undefined ? input.stored : input.requested)
}

const requireUserChat = Effect.fn("SqliteAutomationStore.requireUserChat")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: "create" | "update",
  automationId?: string
) {
  const rows = yield* sql<{
    readonly session_type: string
    readonly origin_automation_id: string | null
    readonly origin_purpose: JobPurpose | null
  }>`
    SELECT session.session_type, session.origin_automation_id, origin.purpose AS origin_purpose
    FROM sessions AS session LEFT JOIN scheduled_tasks AS origin
      ON origin.task_id = session.origin_automation_id
    WHERE session.session_id = ${sessionId} AND session.archived_at IS NULL
    LIMIT 1
  `
  const chat = rows[0]
  const yours =
    (chat?.session_type === "chat" && chat.origin_automation_id === null) ||
    (chat?.session_type === "channel" &&
      chat.origin_purpose !== null &&
      isSpaceWorkJob({ purpose: chat.origin_purpose }))
  if (!yours) {
    return yield* storeError(
      operation,
      "invalid",
      "An Automation's chat must be one of your active chats or a Space room",
      automationId
    )
  }
})

const refuseSystemRunOnlyIf = (
  triggers: PersonalAutomationTriggers["triggers"],
  automationId: string
): Effect.Effect<void, AutomationStoreError> =>
  triggers.some((trigger) => trigger.type === "event" && trigger.run_only_if !== undefined)
    ? Effect.fail(
        storeError(
          "update",
          "invalid",
          "A system Automation's triggers take no run_only_if sentence",
          automationId
        )
      )
    : Effect.void
