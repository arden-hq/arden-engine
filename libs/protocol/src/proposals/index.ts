import { decoderFor, makeEncoder, runBoundary } from "../common/boundary.js"
import type {
  RecheckTaskProposalInput,
  ResolveTaskProposalInput,
  TaskProposalScope
} from "./contracts.js"
import {
  ResolveTaskProposalResponseSchema,
  TaskProposalListSchema,
  TaskProposalSchema,
  TaskProposalConflictSchema,
  TaskProposalReviewSchema,
  TaskProposalReviewStatusSchema,
  encodeRecheckTaskProposalRequestEffect,
  encodeResolveTaskProposalRequestEffect
} from "./schema.js"
import {
  encodeTaskProposalListPathEffect,
  encodeTaskProposalResolvePathEffect,
  encodeTaskProposalRecheckPathEffect
} from "./routes.js"

export * from "./contracts.js"

export const taskProposalDecoders = {
  review: decoderFor(TaskProposalReviewSchema, "Invalid Task proposal review"),
  reviewStatus: decoderFor(TaskProposalReviewStatusSchema, "Invalid Task proposal review status"),
  conflict: decoderFor(TaskProposalConflictSchema, "Invalid Task proposal conflict"),
  proposal: decoderFor(TaskProposalSchema, "Invalid Task proposal"),
  list: decoderFor(TaskProposalListSchema, "Invalid Task proposal list"),
  resolve: decoderFor(ResolveTaskProposalResponseSchema, "Invalid Task proposal resolution")
} as const

export const taskProposalRequests = {
  recheck: makeEncoder<RecheckTaskProposalInput>(
    encodeRecheckTaskProposalRequestEffect,
    "Invalid Task proposal recheck request"
  ),
  resolve: makeEncoder<ResolveTaskProposalInput>(
    encodeResolveTaskProposalRequestEffect,
    "Invalid Task proposal resolution request"
  )
} as const

export const taskProposalRoutes = {
  recheck(proposalId: string): string {
    return runBoundary(
      encodeTaskProposalRecheckPathEffect(proposalId),
      "Invalid Task proposal recheck route",
      "encode"
    )
  },
  list(scope: TaskProposalScope): string {
    return runBoundary(
      encodeTaskProposalListPathEffect(scope),
      "Invalid Task proposal list route",
      "encode"
    )
  },
  resolve(proposalId: string): string {
    return runBoundary(
      encodeTaskProposalResolvePathEffect(proposalId),
      "Invalid Task proposal resolution route",
      "encode"
    )
  }
} as const
