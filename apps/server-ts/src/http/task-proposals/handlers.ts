import {
  TASK_PROPOSAL_DECISION,
  TASK_PROPOSAL_PLACEMENT,
  TASK_PROPOSAL_STATUS,
  type TaskProposalScope
} from "@arden-hq/protocol/proposals"
import { SOURCE_KIND } from "@arden-hq/protocol/spaces/work"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { TaskProposalStore, TaskProposalStoreError } from "../../persistence/proposals/store.js"
import { TaskProposalConflictError } from "../../persistence/proposals/conflict.js"
import { ProposalConflictResponse } from "./api.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { spaceOwnsPath } from "../../wiki/space-index.js"
import { Wiki } from "../../wiki/service.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

const scopeOf = (
  query:
    | { readonly place: "space"; readonly space_id: string }
    | { readonly place: "chat"; readonly session_id: string }
): TaskProposalScope =>
  query.place === TASK_PROPOSAL_PLACEMENT.space
    ? { place: "space", spaceId: query.space_id }
    : { place: "chat", sessionId: query.session_id }

export const TaskProposalHandlers = HttpApiBuilder.group(
  ArdenApi,
  "taskProposals",
  Effect.fn("TaskProposalHandlers")(function* (handlers) {
    const proposals = yield* TaskProposalStore
    const spaces = yield* SpaceStore
    const wiki = yield* Wiki
    return handlers
      .handle("history", ({ params, query }) =>
        proposals.history({ id: params.proposalId, ...query }).pipe(Effect.catch(failStore))
      )
      .handle("list", ({ query }) => proposals.list(scopeOf(query)).pipe(Effect.catch(failStore)))
      .handle("recheck", ({ params, payload }) =>
        proposals
          .requestProposalReview({
            proposalId: params.proposalId,
            expectedRevision: payload.expected_revision
          })
          .pipe(
            Effect.catchTag("TaskProposalConflictError", (error) =>
              Effect.fail(
                new ProposalConflictResponse({ kind: error.kind, message: error.message })
              )
            ),
            Effect.catchTag("TaskProposalStoreError", failStore)
          )
      )
      .handle("reviewStatus", ({ params }) =>
        proposals.proposalReviewStatus({ proposalId: params.proposalId }).pipe(
          Effect.map((review) => review ?? { state: "unrequested" as const }),
          Effect.catch(failStore)
        )
      )
      .handle("resolve", ({ params, payload }) =>
        Effect.gen(function* () {
          const proposal = yield* proposals.get(params.proposalId)
          if (
            proposal?.status === TASK_PROPOSAL_STATUS.offered &&
            proposal.revision !== payload.expected_revision
          ) {
            return yield* new TaskProposalConflictError({
              kind: "proposal_changed",
              message: "This suggestion changed. Review the updated instructions before starting."
            })
          }
          const memorySources =
            proposal?.status === TASK_PROPOSAL_STATUS.offered &&
            payload.decision === TASK_PROPOSAL_DECISION.accept
              ? proposal.sources.filter((source) => source.kind === SOURCE_KIND.memory)
              : []
          const spaceId =
            memorySources.length === 0 ? undefined : yield* proposals.memoryScope(params.proposalId)
          if (spaceId === undefined) {
            return yield* proposals.resolve(params.proposalId, payload, { memory: [] })
          }
          const space = yield* spaces.get(spaceId).pipe(
            Effect.mapError(
              (cause) =>
                new TaskProposalStoreError({
                  reason: "storage",
                  message: "Could not validate Task proposal Memory evidence",
                  cause
                })
            )
          )
          if (space === null || space.archived_at !== null) {
            return yield* new TaskProposalConflictError({
              kind: "space_unavailable",
              message: "This Space is archived or unavailable. Restore it before starting."
            })
          }
          if (space.page_path === null) {
            return yield* new TaskProposalConflictError({
              kind: "space_unavailable",
              message:
                "This Space has no current Memory boundary. Restore its Memory page before starting."
            })
          }
          const boundaryPath = space.page_path
          const snapshot = yield* wiki.snapshot().pipe(
            Effect.mapError(
              (cause) =>
                new TaskProposalStoreError({
                  reason: "storage",
                  message: "Could not read current Memory evidence",
                  cause
                })
            )
          )
          const memory = yield* Effect.forEach(memorySources, (source) => {
            const current = snapshot.pages.find((record) => record.page.pageId === source.page_ref)
            if (
              current === undefined ||
              current.page.lifecycle !== WIKI_PAGE_LIFECYCLE.active ||
              !spaceOwnsPath(boundaryPath, current.resource.path)
            ) {
              return Effect.fail(
                new TaskProposalConflictError({
                  kind: "source_unavailable",
                  message:
                    "A source is no longer available on this Space. Recheck the suggestion before starting."
                })
              )
            }
            if (current.resource.versionId !== source.revision) {
              return Effect.fail(
                new TaskProposalConflictError({
                  kind: "source_changed",
                  message:
                    "A source changed since this was suggested. Recheck the suggestion before starting."
                })
              )
            }
            return Effect.succeed({
              page_ref: current.page.pageId,
              revision: current.resource.versionId
            })
          })
          return yield* proposals.resolve(params.proposalId, payload, { memory })
        }).pipe(
          Effect.catchTag("TaskProposalConflictError", (error) =>
            Effect.fail(new ProposalConflictResponse({ kind: error.kind, message: error.message }))
          ),
          Effect.catchTag("TaskProposalStoreError", failStore)
        )
      )
  })
)
