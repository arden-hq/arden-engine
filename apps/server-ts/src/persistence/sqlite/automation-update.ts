import { AUTOMATION_WRITE_TOOL } from "../automations/tool-names.js"
import { openRunSince } from "./automation-running.js"
import { captureMutationVersions } from "./mutation-links.js"
import { haltAutomation } from "./automation-halt.js"
import { UpdateAutomationInputSchema } from "@arden-hq/protocol/effect/automations"
import { Clock, Effect, Schema } from "effect"
import { type PromptWriter, type AutomationCatalog } from "../automations/catalog.js"
import { AutomationStoreError } from "../automations/store.js"
import { JOB_PURPOSE, isUserAutomationPurpose } from "../job-classification.js"
import { chatsFollowJobName } from "./job-labels.js"
import { decodeJson, encodeJson } from "./json.js"
import { contextHistory, historyContextMode, setupModel } from "./automation-chat-history.js"
import {
  AutomationTriggersSchema,
  sameTriggers,
  refuseSystemRunOnlyIf,
  scheduleEffect,
  writtenTriggers
} from "./automation-schedule.js"
import { resumeAutomation } from "./automation-resume.js"
import { automationPatch } from "../automations/automation-patch.js"
import { ownChat } from "./automation-own-chat.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import {
  dropMeasuredRows,
  makeTriggerArming,
  rematchHeldEvents
} from "./automation-trigger-arming.js"
import { specSchedule } from "./system-automations.js"
import { strict, storeError, automationIdEffect, systemSpecOf } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import {
  hasRunOnlyIf,
  lockedSystemChanges,
  lockedSystemMessage,
  systemTakesTrigger
} from "../automations/system-settings.js"
import {
  prepareInstructionRevision,
  type AutomationWriteSource
} from "./automation-instruction-provenance.js"
import { makeAutomationRowReads } from "./automation-row-reads.js"
import { updatedNextRunAt } from "./automation-next-run.js"
import type { makeChosenThread } from "./automation-chosen-thread.js"
import {
  AUTOMATION_CHAT_CHOICE,
  AUTOMATION_HISTORY,
  type Automation
} from "@arden-hq/protocol/automations"

export type UpdateAutomation = (
  automationId: string,
  input: Parameters<AutomationCatalog["Service"]["update"]>[1],
  promptWriter: PromptWriter,
  source?: AutomationWriteSource
) => Effect.Effect<Automation | null, AutomationStoreError>

export const makeAutomationUpdate = ({
  writer,
  sessionEvents,
  rules,
  chosenThread
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules"> & {
  readonly chosenThread: ReturnType<typeof makeChosenThread>
}): UpdateAutomation => {
  const sql = writer.sql
  const { findAutomationRow, get } = makeAutomationRowReads({ writer, rules })
  const { rearmAutomation } = makeTriggerArming({ writer, sessionEvents })
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
      Effect.map(({ changes }) => automationPatch(changes)),
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
          const spec =
            row.purpose === JOB_PURPOSE.system ? yield* systemSpecOf(rules, row, "update") : null
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
              (yield* sql`
                SELECT 1 WHERE ${openRunSince(sql, sql`${validAutomationId}`)} IS NOT NULL
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
          if (chatKind === AUTOMATION_CHAT_CHOICE.yours && history === AUTOMATION_HISTORY.fresh) {
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
          if (spec !== null && !spec.triggers.some(hasRunOnlyIf))
            yield* refuseSystemRunOnlyIf(schedule.triggers, validAutomationId)
          if (
            spec !== null &&
            !schedule.triggers.every((trigger) => systemTakesTrigger(spec, trigger))
          )
            return yield* storeError(
              "update",
              "invalid",
              "This system Automation takes only triggers for new mail, GitHub items and calendar changes",
              validAutomationId
            )
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
                  toolName: AUTOMATION_WRITE_TOOL.update,
                  writtenAt: iso(yield* Clock.currentTimeMillis)
                })
              : row.instruction_revision_id
          yield* chatsFollowJobName(sql, validAutomationId, name)
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
          else if (valid.enabled === false && row.enabled === 0)
            yield* sql`UPDATE scheduled_tasks SET auto_resume_at = NULL
              WHERE task_id = ${validAutomationId}`
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
            SET chat_model = ${model}
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
  return update
}
