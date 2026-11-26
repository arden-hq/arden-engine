import { Effect, Schema } from "effect"

import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"
import { PositiveIntSchema } from "../../common/schema.js"
import { SpaceWorkPageOptionsSchema } from "./page-schema.js"
import { WORK_PAGE_SCOPE, WORK_PAGE_START } from "./contracts.js"

const SpaceIdSchema = routeSegment()
const ItemIdSchema = routeSegment()
const SessionIdSchema = routeSegment()

const chatTaskPath = (sessionId: string): string =>
  `/sessions/${encodeSegment(sessionId)}/chat-task`

export const encodeChatTaskPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(SessionIdSchema, value, chatTaskPath)

const workCollectionPath = (spaceId: string): string => `/spaces/${encodeSegment(spaceId)}/work`

const workItemPath = (itemId: string): string => `/spaces/work/${encodeSegment(itemId)}`

export const encodeWorkCollectionPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(SpaceIdSchema, value, workCollectionPath)

export const encodeWorkItemPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(ItemIdSchema, value, workItemPath)

export const encodeWorkStopPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(ItemIdSchema, value, (itemId) => `${workItemPath(itemId)}/stop`)

export const encodeWorkCommentPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(ItemIdSchema, value, (itemId) => `${workItemPath(itemId)}/comments`)

export const encodeWorkAttachmentUploadPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(ItemIdSchema, value, (itemId) => `${workItemPath(itemId)}/attachments`)

export const encodeWorkAttachmentPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    PositiveIntSchema,
    value,
    (attachmentId) => `/spaces/work/attachments/${attachmentId}`
  )

export const encodeWorkPagePathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(SpaceWorkPageOptionsSchema)(value, {
    onExcessProperty: "error"
  }).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({ scope: options.scope.kind })
      switch (options.scope.kind) {
        case WORK_PAGE_SCOPE.all:
          break
        case WORK_PAGE_SCOPE.space:
          query.set("space_id", options.scope.space_id)
          break
        case WORK_PAGE_SCOPE.chat:
          query.set("session_id", options.scope.session_id)
          break
        case WORK_PAGE_SCOPE.turn:
          query.set("session_id", options.scope.session_id)
          query.set("turn_id", options.scope.turn_id)
          break
        case WORK_PAGE_SCOPE.item:
          query.set("item_id", options.scope.item_id)
          break
      }
      query.set("start", options.start.kind)
      switch (options.start.kind) {
        case WORK_PAGE_START.first:
          break
        case WORK_PAGE_START.after:
          query.set("cursor", options.start.cursor)
          break
        case WORK_PAGE_START.with_item:
          query.set("target_item_id", options.start.item_id)
          break
      }
      query.set("limit", String(options.limit))
      const search = query.toString()
      return `/spaces/work/all?${search}`
    })
  )

export const encodeTaskChatPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(routeSegment(), value, (itemId) => `/spaces/work/${encodeSegment(itemId)}/chat`)
export const encodeTaskResultReadPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    routeSegment(),
    value,
    (itemId) => `/spaces/work/${encodeSegment(itemId)}/result-read`
  )
