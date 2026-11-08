import { decoderFor, makeEncoder } from "../common/boundary.js"
import type { DismissInboxRequest, MarkInboxReadRequest } from "./contracts.js"
import {
  InboxViewSchema,
  encodeDismissInboxRequestEffect,
  encodeMarkInboxReadRequestEffect
} from "./schema.js"

export * from "./contracts.js"

export const inboxDecoders = {
  view: decoderFor(InboxViewSchema, "Invalid Inbox response")
} as const

export const inboxRequests = {
  markRead: makeEncoder<MarkInboxReadRequest>(
    encodeMarkInboxReadRequestEffect,
    "Invalid Inbox read request"
  ),
  dismiss: makeEncoder<DismissInboxRequest>(
    encodeDismissInboxRequestEffect,
    "Invalid Inbox dismiss request"
  )
} as const

export const inboxRoutes = {
  view: "/inbox",
  markRead: "/inbox/read",
  dismiss: "/inbox/dismiss"
} as const
