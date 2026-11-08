import { Schema } from "effect"
import { decoderFor, makeEncoder, runBoundary } from "../common/boundary.js"
import type { CreateSpaceInput, PinnedSpacesInput, UpdateSpaceInput } from "./contracts.js"
import {
  SpaceConversationResponseSchema,
  SpaceArchiveResponseSchema,
  SpaceDetailSchema,
  SpaceEndConflictSchema,
  SpaceSchema,
  SpaceListResponseSchema,
  SpacesOverviewSchema,
  encodeCreateSpaceRequestEffect,
  encodePinnedSpacesRequestEffect,
  encodeUpdateSpaceRequestEffect
} from "./schema.js"
import {
  encodeSpaceConversationPathEffect,
  encodeSpaceInstructionsPathEffect,
  encodeSpaceItemPathEffect,
  encodeSpacePagePathEffect,
  encodeSpaceRestorePathEffect
} from "./routes.js"

export * from "./contracts.js"

/** The 409 body of a Space archive refused for work running in its chats. */
export const isSpaceEndConflict = Schema.is(SpaceEndConflictSchema)

/** Plain decoders for the live Space projections. */
export const spaceDecoders = {
  conversation: decoderFor(SpaceConversationResponseSchema, "Invalid Space conversation"),
  space: decoderFor(SpaceSchema, "Invalid Space response"),
  list: decoderFor(SpaceListResponseSchema, "Invalid Space-list response"),
  overview: decoderFor(SpacesOverviewSchema, "Invalid Spaces overview"),
  detail: decoderFor(SpaceDetailSchema, "Invalid Space detail"),
  archived: decoderFor(SpaceArchiveResponseSchema, "Invalid Space archive response")
} as const

/** Strict request encoders; callers receive reusable JSON bodies. */
export const spaceRequests = {
  create: makeEncoder<CreateSpaceInput>(
    encodeCreateSpaceRequestEffect,
    "Invalid create-Space request"
  ),
  update: makeEncoder<UpdateSpaceInput>(encodeUpdateSpaceRequestEffect, "Invalid Space update"),
  pinned: makeEncoder<PinnedSpacesInput>(encodePinnedSpacesRequestEffect, "Invalid pinned Spaces")
} as const

const route = (program: ReturnType<typeof encodeSpaceItemPathEffect>, message: string): string =>
  runBoundary(program, message, "encode")

/** The item path serves detail, update, and archive operations. */
export const spaceRoutes = {
  collection: "/spaces",
  overview: "/spaces/overview",
  pinned: "/spaces/pinned",
  archived: "/spaces/archived",
  item(spaceId: string): string {
    return route(encodeSpaceItemPathEffect(spaceId), "Invalid Space route")
  },
  overviewHistory(spaceId: string): string {
    return `${route(encodeSpaceItemPathEffect(spaceId), "Invalid Space route")}/overview-history`
  },
  conversation(spaceId: string): string {
    return route(encodeSpaceConversationPathEffect(spaceId), "Invalid Space-conversation route")
  },
  page(spaceId: string): string {
    return route(encodeSpacePagePathEffect(spaceId), "Invalid Space-page route")
  },
  /** `stop`: stop the work running in the Space's chats first. */
  archive(spaceId: string, { stop }: { readonly stop: boolean }): string {
    return `${route(encodeSpaceItemPathEffect(spaceId), "Invalid Space route")}${stop ? "?stop=true" : ""}`
  },
  restore(spaceId: string): string {
    return route(encodeSpaceRestorePathEffect(spaceId), "Invalid Space-restore route")
  },
  instructions(spaceId: string): string {
    return route(encodeSpaceInstructionsPathEffect(spaceId), "Invalid Space-instructions route")
  }
} as const
export type { SpaceApprovalMode } from "./contracts.js"
