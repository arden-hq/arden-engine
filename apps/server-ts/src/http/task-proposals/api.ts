import {
  RecordedHistoryPageSchema,
  RecordedHistoryHttpQuerySchema
} from "../../persistence/history.js"
import {
  ResolveTaskProposalInputSchema,
  RecheckTaskProposalInputSchema,
  TaskProposalReviewSchema,
  TaskProposalReviewStatusSchema,
  TaskProposalConflictKindSchema,
  ResolveTaskProposalResponseSchema,
  TaskProposalListQuerySchema,
  TaskProposalListSchema
} from "@arden-hq/protocol/effect/proposals"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreInvalid, StoreConflict } from "../errors.js"

export class ProposalConflictResponse extends Schema.Error<ProposalConflictResponse>(
  "ProposalConflictResponse"
)({ kind: TaskProposalConflictKindSchema, message: Schema.String }, { httpApiStatus: 409 }) {}

const errors = [
  ProposalConflictResponse,
  HttpApiError.NotFoundNoContent,
  StoreConflict,
  StoreInvalid,
  HttpApiError.InternalServerErrorNoContent
]

export class TaskProposalsApi extends HttpApiGroup.make("taskProposals", { topLevel: true }).add(
  HttpApiEndpoint.get("history", "/proposals/:proposalId/history", {
    params: { proposalId: Schema.NonEmptyString },
    query: RecordedHistoryHttpQuerySchema,
    success: RecordedHistoryPageSchema,
    error: errors
  }),
  HttpApiEndpoint.get("list", "/proposals", {
    query: TaskProposalListQuerySchema,
    success: TaskProposalListSchema,
    error: [HttpApiError.BadRequestNoContent, ...errors]
  }),
  HttpApiEndpoint.post("recheck", "/proposals/:proposalId/recheck", {
    params: { proposalId: Schema.NonEmptyString },
    payload: RecheckTaskProposalInputSchema,
    success: TaskProposalReviewSchema,
    error: errors
  }),
  HttpApiEndpoint.get("reviewStatus", "/proposals/:proposalId/recheck", {
    params: { proposalId: Schema.NonEmptyString },
    success: TaskProposalReviewStatusSchema,
    error: errors
  }),
  HttpApiEndpoint.post("resolve", "/proposals/:proposalId/resolve", {
    params: { proposalId: Schema.NonEmptyString },
    payload: ResolveTaskProposalInputSchema,
    success: ResolveTaskProposalResponseSchema,
    error: errors
  })
) {}
