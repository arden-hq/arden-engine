import { AUTOMATION_WRITE_TOOL } from "../automations/tool-names.js"
import { captureMutationVersions } from "./mutation-links.js"
import {
  AUTOMATION_CHAT_CHOICE,
  AUTOMATION_HISTORY,
  freshTriggerIds
} from "@arden-hq/protocol/automations"
import {
  AutomationDescriptionInputSchema,
  InternalCreateAutomationRequestSchema
} from "@arden-hq/protocol/effect/automations"
import { Clock, Effect, Schema } from "effect"
import { type PromptWriter, type AutomationCatalog } from "../automations/catalog.js"
import { AutomationStoreError } from "../automations/store.js"
import { namedPublicRef } from "../public-ref.js"
import { encodeJson } from "./json.js"
import { historyContextMode, setupModel } from "./automation-chat-history.js"
import { AutomationTriggersSchema, scheduleEffect } from "./automation-schedule.js"
import { cooldownMinutesOf, modelIdOf } from "../automations/automation-patch.js"
import { nextId } from "./deps.js"
import { insertOwnChat } from "./automation-own-chat.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { strict, storeError } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import {
  prepareInstructionRevision,
  type AutomationWriteSource
} from "./automation-instruction-provenance.js"
import { makeAutomationRowReads } from "./automation-row-reads.js"
import { requireUserChat } from "./automation-user-chat.js"

export const makeAutomationCreate = ({
  writer,
  sessionEvents,
  rules
}: Pick<
  AutomationStoreDeps,
  "writer" | "sessionEvents" | "rules"
>): AutomationCatalog["Service"]["create"] => {
  const sql = writer.sql
  const { get } = makeAutomationRowReads({ writer, rules })
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
    const chat = valid.chat
    const model = yield* setupModel({
      chat: chat.kind,
      history: valid.history,
      requested: modelIdOf(valid.model),
      stored: null,
      operation: "create"
    })
    const written = freshTriggerIds(valid.triggers)
    const schedule = yield* scheduleEffect(rules, written.triggers, "create")
    const automationId = `automation:${yield* nextId}`
    const ownChatId = yield* nextId
    const nowMs = yield* Clock.currentTimeMillis
    const timestamp = iso(nowMs)
    const enabled = valid.enabled
    const nextRun = enabled ? rules.nextRunAt(schedule, nowMs) : null
    const description = AutomationDescriptionInputSchema.match(valid.description, {
      none: () => ({ text: null, source: null }),
      manual: ({ text }) => ({ text, source: "manual" })
    })
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
          const threadId = chat.kind === AUTOMATION_CHAT_CHOICE.yours ? chat.session_id : ownChatId
          if (chat.kind === AUTOMATION_CHAT_CHOICE.yours)
            yield* requireUserChat(sql, chat.session_id, "create")
          const instructionRevisionId = yield* prepareInstructionRevision(sql, {
            automationId,
            instruction: {
              prompt: valid.prompt,
              model,
              context_mode: historyContextMode(valid.history),
              triggers: triggersJson,
              thread_id: threadId,
              cooldown_minutes: cooldownMinutesOf(valid.cooldown)
            },
            previousRevisionId: null,
            promptAuthor: promptWriter,
            source,
            toolName: AUTOMATION_WRITE_TOOL.create,
            writtenAt: timestamp
          })
          const insertAutomation = sql`
          INSERT INTO scheduled_tasks (
            task_id, automation_ref, name, description, description_source,
            prompt, model, context_mode, triggers, trigger_last_id, enabled, created_at, last_run_at,
            next_run_at, last_result, auto_approve, handler,
            builtin, cooldown_minutes, thread_id, idempotency_key, idempotency_scope,
            tool_scope, triggers_source, purpose, prompt_author, instruction_revision_id
          ) VALUES (
            ${automationId}, ${namedPublicRef(valid.name, automationId)}, ${valid.name},
            ${description.text}, ${description.source},
            ${valid.prompt}, ${model}, ${historyContextMode(valid.history)}, ${triggersJson},
            ${written.lastId}, ${enabled ? 1 : 0}, ${timestamp}, NULL, ${nextRun === null ? null : iso(nextRun)},
            NULL, 0, NULL, 0, ${cooldownMinutesOf(valid.cooldown)},
            ${threadId},
            ${valid.idempotency_key}, 'global', 'all', 'manual', 'user_automation', ${promptWriter},
            ${instructionRevisionId}
          )
        `
          if (
            chat.kind === AUTOMATION_CHAT_CHOICE.yours &&
            valid.history === AUTOMATION_HISTORY.chat
          ) {
            yield* insertAutomation
          } else {
            yield* insertOwnChat({
              sql,
              sessionEvents,
              automationId,
              sessionId: ownChatId,
              name: valid.name,
              model,
              approvalMode: valid.approval_mode,
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
  return create
}
