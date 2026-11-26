import { STOPPED_RUN_OUTCOME } from "../../work/stop-task-runs.js"
import { TASK_STATUS } from "@arden-hq/protocol/spaces/work"
import {
  storedResolveInput,
  wireRunQuestion,
  wireRunQuestionList
} from "../../persistence/runs/stored-question.js"
import { StopTaskRecordSchema, WorkPageRecordSchema } from "../../persistence/work/task-record.js"
import { HomeStore } from "../../persistence/home/store.js"
import { SpaceWorkPageQuerySchema } from "@arden-hq/protocol/effect/spaces/work"
import { runQuestionListOptions, workerAttemptPageOptions } from "@arden-hq/protocol/effect/runs"
import { chatTaskDraft, taskDraft } from "../../persistence/work/task-input.js"
import { taskPatchOf } from "../../persistence/work/task-patch.js"
import {
  publicAttachment,
  publicComment,
  publicPage,
  publicStop,
  publicTask
} from "../../persistence/work/public.js"
import {
  LOOSE_TASK_HOME,
  WORK_PAGE_SCOPE,
  WORK_PAGE_START,
  type SpaceWorkPageOptions,
  type WorkPageScope,
  type WorkPageStart
} from "@arden-hq/protocol/spaces/work"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { ChatMessage } from "../../chat/message.js"
import type { ChatMessageShape } from "../../chat/message-shape.js"
import { WorkStore, type TaskAddress } from "../../persistence/work/store.js"
import { ArdenApi } from "../api.js"
import { failInternal, failStore, orNotFound } from "../errors.js"
import { stopTaskRuns } from "../../work/stop-task-runs.js"

const textEncoder = new TextEncoder()

const attachmentDisposition = (name: string): string => {
  const encoded = Array.from(
    textEncoder.encode(name),
    (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  ).join("")
  return `attachment; filename*=UTF-8''${encoded}`
}

const stopTask = Effect.fn("WorkHandlers.stopTask")(function* (options: {
  readonly store: Pick<WorkStore["Service"], "stop" | "activeTaskRuns">
  readonly chat: Pick<ChatMessageShape, "cancel">
  readonly address: TaskAddress
  readonly expectedUpdatedAt: string
}) {
  const task = yield* options.store.stop(options.address, options.expectedUpdatedAt)
  const runs = yield* stopTaskRuns({
    work: options.store,
    chat: options.chat,
    itemId: task.item_id
  })
  let state: "acknowledged" | "finished" | "partial" = "finished"
  if (runs.some((run) => run.outcome === STOPPED_RUN_OUTCOME.failed)) state = "partial"
  else if (runs.some((run) => run.outcome === STOPPED_RUN_OUTCOME.acknowledged))
    state = "acknowledged"
  return {
    task,
    authority: "revoked" as const,
    state,
    runs
  }
})

const pageScope = (query: typeof SpaceWorkPageQuerySchema.Type): WorkPageScope => {
  switch (query.scope) {
    case WORK_PAGE_SCOPE.all:
      return { kind: WORK_PAGE_SCOPE.all }
    case WORK_PAGE_SCOPE.space:
      return { kind: WORK_PAGE_SCOPE.space, space_id: query.space_id }
    case WORK_PAGE_SCOPE.chat:
      return { kind: WORK_PAGE_SCOPE.chat, session_id: query.session_id }
    case WORK_PAGE_SCOPE.turn:
      return { kind: WORK_PAGE_SCOPE.turn, session_id: query.session_id, turn_id: query.turn_id }
    case WORK_PAGE_SCOPE.item:
      return { kind: WORK_PAGE_SCOPE.item, item_id: query.item_id }
  }
}

const pageStart = (query: typeof SpaceWorkPageQuerySchema.Type): WorkPageStart => {
  switch (query.start) {
    case WORK_PAGE_START.first:
      return { kind: WORK_PAGE_START.first }
    case WORK_PAGE_START.after:
      return { kind: WORK_PAGE_START.after, cursor: query.cursor }
    case WORK_PAGE_START.with_item:
      return { kind: WORK_PAGE_START.with_item, item_id: query.target_item_id }
  }
}

const pageOptions = (query: typeof SpaceWorkPageQuerySchema.Type): SpaceWorkPageOptions => ({
  scope: pageScope(query),
  start: pageStart(query),
  limit: query.limit
})

export const WorkHandlers = HttpApiBuilder.group(
  ArdenApi,
  "work",
  Effect.fn("WorkHandlers")(function* (handlers) {
    const home = yield* HomeStore
    const store = yield* WorkStore
    const chat = yield* ChatMessage
    return handlers
      .handle("history", ({ params, query }) =>
        store.history({ id: params.itemId, ...query }).pipe(Effect.catch(failStore))
      )
      .handle("homePresence", ({ payload }) =>
        home.homePresence(payload).pipe(Effect.as({ ok: true as const }), Effect.catch(failStore))
      )
      .handle("moveToChat", ({ params, payload }) =>
        store
          .moveToChat({ itemId: params.itemId, sessionId: payload.session_id })
          .pipe(Effect.as({ ok: true as const }), Effect.catch(failStore))
      )
      .handle("acknowledgeResult", ({ params, payload }) =>
        store
          .acknowledgeResult({
            itemId: params.itemId,
            resultKey: payload.result_key
          })
          .pipe(Effect.as({ ok: true as const }), Effect.catch(failStore))
      )
      .handle("attempts", ({ params, query }) =>
        store.attempts(params.itemId, workerAttemptPageOptions(query)).pipe(Effect.catch(failStore))
      )
      .handle("questions", ({ query }) =>
        store
          .questions(runQuestionListOptions(query))
          .pipe(Effect.map(wireRunQuestionList), Effect.catch(failStore))
      )
      .handle("resolveQuestion", ({ params, payload }) =>
        store
          .resolveQuestion({
            questionId: params.questionId,
            input: storedResolveInput(payload)
          })
          .pipe(Effect.map(wireRunQuestion), Effect.catch(failStore))
      )
      .handle("create", ({ params, payload }) =>
        store
          .create({ kind: "space", spaceId: params.spaceId }, taskDraft(payload))
          .pipe(Effect.map(publicTask), Effect.catch(failStore))
      )
      .handle("createLoose", ({ payload }) => {
        return store
          .create(
            payload.home.kind === LOOSE_TASK_HOME.chat
              ? { kind: "chat", sessionId: payload.home.session_id }
              : { kind: "none" },
            taskDraft(payload)
          )
          .pipe(Effect.map(publicTask), Effect.catch(failStore))
      })
      .handle("createChatTask", ({ params, payload }) =>
        store.createInChat(params.sessionId, chatTaskDraft(payload)).pipe(
          Effect.tap((task) =>
            chat.continueTask({ itemId: task.item_id, sourceId: `start:${task.updated_at}` })
          ),
          Effect.map(publicTask),
          Effect.catch(failStore)
        )
      )
      .handle("comment", ({ params, payload }) =>
        store
          .comment({ kind: "item", itemId: params.itemId }, payload)
          .pipe(
            Effect.map(publicComment),
            Effect.catchTag("TaskDirectionChanged", Effect.die),
            Effect.catch(failStore)
          )
      )
      .handle("update", ({ params, payload }) => {
        const patch = taskPatchOf(payload.changes)
        return store
          .update({ kind: "item", itemId: params.itemId }, payload.expected_updated_at, patch)
          .pipe(
            Effect.tap((task) =>
              patch.status === TASK_STATUS.cancelled || patch.status === TASK_STATUS.done
                ? stopTaskRuns({ work: store, chat, itemId: task.item_id }).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("A closed Task's runs were not stopped at once", cause)
                    )
                  )
                : Effect.void
            ),
            Effect.map(publicTask),
            Effect.catchTag("TaskDirectionChanged", Effect.die),
            Effect.catch(failStore)
          )
      })
      .handle("stop", ({ params, payload }) =>
        stopTask({
          store,
          chat,
          address: { kind: "item", itemId: params.itemId },
          expectedUpdatedAt: payload.expected_updated_at
        }).pipe(
          Effect.catch(failStore),
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(StopTaskRecordSchema)(response).pipe(
              Effect.map(publicStop),
              Effect.catch(failInternal("Work"))
            )
          )
        )
      )
      .handle("createAttachment", ({ params, payload }) =>
        store
          .createAttachment({ kind: "item", itemId: params.itemId }, payload)
          .pipe(Effect.map(publicAttachment), Effect.catch(failStore))
      )
      .handle("attachment", ({ params }) =>
        store.attachment(params.attachmentId).pipe(
          Effect.catch(failInternal("Work")),
          Effect.flatMap(orNotFound),
          Effect.map((attachment) =>
            HttpApiSchema.withHeaders({
              body: attachment.data,
              headers: {
                "content-type": attachment.metadata.media_type,
                "content-disposition": attachmentDisposition(attachment.metadata.name)
              }
            })
          )
        )
      )
      .handle("page", ({ query }) =>
        store.page(pageOptions(query)).pipe(
          Effect.catch(failStore),
          Effect.flatMap((page) =>
            Schema.decodeUnknownEffect(WorkPageRecordSchema)(page).pipe(
              Effect.map(publicPage),
              Effect.catch(failInternal("Work"))
            )
          )
        )
      )
  })
)
