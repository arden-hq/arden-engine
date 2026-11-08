import { Effect, Schema } from "effect"

import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"
import { PositiveIntSchema } from "../../common/schema.js"
import { SpaceWorkPageOptionsSchema } from "./schema.js"

const SpaceIdSchema = routeSegment()
const ItemIdSchema = routeSegment()
const SessionIdSchema = routeSegment()

const chatTaskPath = (sessionId: string): string =>
  `/sessions/${encodeSegment(sessionId)}/chat-task`

export const encodeChatTaskPathEffect = (value: unknown) =>
  encodeRouteEffect(SessionIdSchema, value, chatTaskPath)

const workCollectionPath = (spaceId: string): string => `/spaces/${encodeSegment(spaceId)}/work`

const workItemPath = (itemId: string): string => `/spaces/work/${encodeSegment(itemId)}`

export const encodeWorkCollectionPathEffect = (value: unknown) =>
  encodeRouteEffect(SpaceIdSchema, value, workCollectionPath)

export const encodeWorkItemPathEffect = (value: unknown) =>
  encodeRouteEffect(ItemIdSchema, value, workItemPath)

export const encodeWorkStopPathEffect = (value: unknown) =>
  encodeRouteEffect(ItemIdSchema, value, (itemId) => `${workItemPath(itemId)}/stop`)

export const encodeWorkCommentPathEffect = (value: unknown) =>
  encodeRouteEffect(ItemIdSchema, value, (itemId) => `${workItemPath(itemId)}/comments`)

export const encodeWorkAttachmentUploadPathEffect = (value: unknown) =>
  encodeRouteEffect(ItemIdSchema, value, (itemId) => `${workItemPath(itemId)}/attachments`)

export const encodeWorkAttachmentPathEffect = (value: unknown) =>
  encodeRouteEffect(
    PositiveIntSchema,
    value,
    (attachmentId) => `/spaces/work/attachments/${attachmentId}`
  )

export const encodeWorkPagePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SpaceWorkPageOptionsSchema)(value, {
    onExcessProperty: "error"
  }).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams()
      if (options.spaceId !== undefined) query.set("space_id", options.spaceId)
      if (options.sessionId !== undefined) query.set("session_id", options.sessionId)
      if (options.turnId !== undefined) query.set("turn_id", options.turnId)
      if (options.itemId !== undefined) query.set("item_id", options.itemId)
      if (options.limit !== undefined) query.set("limit", String(options.limit))
      if (options.cursor !== undefined) query.set("cursor", options.cursor)
      if (options.targetItemId !== undefined) query.set("target_item_id", options.targetItemId)
      const search = query.toString()
      return `/spaces/work/all${search === "" ? "" : `?${search}`}`
    })
  )

export const encodeTaskChatPathEffect = (value: unknown) =>
  encodeRouteEffect(routeSegment(), value, (itemId) => `/spaces/work/${encodeSegment(itemId)}/chat`)
export const encodeTaskResultReadPathEffect = (value: unknown) =>
  encodeRouteEffect(
    routeSegment(),
    value,
    (itemId) => `/spaces/work/${encodeSegment(itemId)}/result-read`
  )
