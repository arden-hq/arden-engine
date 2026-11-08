import type { TaskProposalScope } from "@arden-hq/protocol/proposals"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { TaskProposalStore, TaskProposalStoreError } from "../../persistence/proposals/store.js"
import { TaskProposalConflictError } from "../../persistence/proposals/conflict.js"
import { ProposalConflictResponse } from "./api.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { wikiPathWithinSpaceBoundary } from "../../wiki/authority.js"
import { Wiki } from "../../wiki/service.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

const scopeOf = (query: {
  readonly place: TaskProposalScope["place"]
  readonly space_id?: string
  readonly session_id?: string
}): TaskProposalScope | undefined => {
  switch (query.place) {
    case "space":
      return query.space_id === undefined ? undefined : { place: "space", spaceId: query.space_id }
    case "chat":
      return query.session_id === undefined
        ? undefined
        : { place: "chat", sessionId: query.session_id }
    case "home":
      return { place: "home" }
  }
}

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
      .handle("list", ({ query }) => {
        const scope = scopeOf(query)
        return scope === undefined
          ? Effect.fail(new HttpApiError.BadRequest())
          : proposals.list(scope).pipe(Effect.catch(failStore))
      })
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
          Effect.map((review) => review ?? null),
          Effect.catch(failStore)
        )
      )
      .handle("resolve", ({ params, payload }) =>
        Effect.gen(function* () {
          const proposal = yield* proposals.get(params.proposalId)
          if (proposal?.status === "offered" && proposal.revision !== payload.expected_revision) {
            return yield* new TaskProposalConflictError({
              kind: "proposal_changed",
              message: "This suggestion changed. Review the updated instructions before starting."
            })
          }
          const spaceId = proposal?.space_id ?? null
          const memorySources =
            proposal?.status === "offered" && payload.decision === "accept"
              ? proposal.sources.filter((source) => source.kind === "memory")
              : []
          if (memorySources.length === 0 || spaceId === null) {
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
              current.page.lifecycle !== "active" ||
              !wikiPathWithinSpaceBoundary(boundaryPath, current.resource.path)
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
