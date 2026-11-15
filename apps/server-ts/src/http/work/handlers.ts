import { HomeStore } from "../../persistence/home/store.js"
import {
  SpaceWorkPageSchema,
  StopSpaceTaskResponseSchema
} from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { addressedHomeLetter } from "../../automations/home-letter-links.js"
import { ChatMessage, type ChatMessageShape } from "../../chat/message.js"
import { WorkStore, type TaskAddress } from "../../persistence/work/store.js"
import { ArdenApi } from "../api.js"
import { failStore, orNotFound } from "../errors.js"
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
  if (runs.some((run) => run.outcome === "failed")) state = "partial"
  else if (runs.some((run) => run.outcome === "acknowledged")) state = "acknowledged"
  return {
    task,
    authority: "revoked" as const,
    state,
    runs
  }
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
      .handle("homeLetter", () =>
        addressedHomeLetter(home).pipe(
          Effect.tapCause((cause) => Effect.logError("Home letter failed", cause)),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("homePresence", ({ payload }) =>
        home.homePresence(payload).pipe(Effect.as({ ok: true as const }), Effect.catch(failStore))
      )
      .handle("homeEvidence", ({ query }) => home.homeEvidence(query).pipe(Effect.catch(failStore)))
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
        store.attempts(params.itemId, query).pipe(Effect.catch(failStore))
      )
      .handle("questions", ({ query }) => store.questions(query).pipe(Effect.catch(failStore)))
      .handle("resolveQuestion", ({ params, payload }) =>
        store
          .resolveQuestion({
            questionId: params.questionId,
            input: payload
          })
          .pipe(Effect.catch(failStore))
      )
      .handle("create", ({ params, payload }) =>
        store
          .create({ kind: "space", spaceId: params.spaceId }, payload)
          .pipe(Effect.catch(failStore))
      )
      .handle("createLoose", ({ payload }) => {
        const { session_id, ...input } = payload
        return store
          .create(
            session_id === undefined ? { kind: "none" } : { kind: "chat", sessionId: session_id },
            input
          )
          .pipe(Effect.catch(failStore))
      })
      .handle("createChatTask", ({ params, payload }) =>
        store.createInChat(params.sessionId, payload).pipe(
          Effect.tap((task) =>
            chat.continueTask({ itemId: task.item_id, sourceId: `start:${task.updated_at}` })
          ),
          Effect.catch(failStore)
        )
      )
      .handle("comment", ({ params, payload }) =>
        store
          .comment({ kind: "item", itemId: params.itemId }, payload)
          .pipe(Effect.catch(failStore))
      )
      .handle("update", ({ params, payload }) => {
        const { expected_updated_at, ...patch } = payload
        return store
          .update({ kind: "item", itemId: params.itemId }, expected_updated_at, patch)
          .pipe(
            Effect.tap((task) =>
              patch.status === "cancelled" || patch.status === "done"
                ? stopTaskRuns({ work: store, chat, itemId: task.item_id }).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("A closed Task's runs were not stopped at once", cause)
                    )
                  )
                : Effect.void
            ),
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
            Schema.decodeUnknownEffect(StopSpaceTaskResponseSchema)(response).pipe(
              Effect.mapError(() => new HttpApiError.InternalServerError({}))
            )
          )
        )
      )
      .handle("createAttachment", ({ params, payload }) =>
        store
          .createAttachment({ kind: "item", itemId: params.itemId }, payload)
          .pipe(Effect.catch(failStore))
      )
      .handle("attachment", ({ params }) =>
        store.attachment(params.attachmentId).pipe(
          Effect.mapError(() => new HttpApiError.InternalServerError({})),
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
        store
          .page({
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.target_item_id === undefined ? {} : { targetItemId: query.target_item_id }),
            ...(query.space_id === undefined ? {} : { spaceId: query.space_id }),
            ...(query.session_id === undefined ? {} : { sessionId: query.session_id }),
            ...(query.turn_id === undefined ? {} : { turnId: query.turn_id }),
            ...(query.item_id === undefined ? {} : { itemId: query.item_id })
          })
          .pipe(
            Effect.catch(failStore),
            Effect.flatMap((page) =>
              Schema.decodeUnknownEffect(SpaceWorkPageSchema)(page).pipe(
                Effect.mapError(() => new HttpApiError.InternalServerError({}))
              )
            )
          )
      )
  })
)
