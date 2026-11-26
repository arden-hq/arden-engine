import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { expect, it } from "vitest"
import {
  taskProposalDecoders,
  type TaskProposal,
  type TaskProposalReview
} from "@arden-hq/protocol/proposals"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { TaskProposalHandlers } from "../src/http/task-proposals/handlers.js"
import { TaskProposalsApi } from "../src/http/task-proposals/api.js"
import { Wiki } from "../src/wiki/service.js"

class ProposalTestApi extends HttpApi.make("arden-server").add(TaskProposalsApi) {}

const proposal: TaskProposal = {
  proposal_id: "p1",
  placement: { kind: "space", space_id: "d1" },
  stable_key: "approved-messages",
  text: "Send approved messages",
  body: { kind: "plain" },
  owner: "worker",
  capture: { basis: "inferred", reason: "Approved in Memory." },
  sources: [{ kind: "memory", page_ref: "memory-page", revision: "memory-old" }],
  signal: { kind: "unsignalled" },
  origin: {
    kind: "run",
    run_id: "run1",
    session_id: "session1",
    turn_id: "turn1",
    tool_call_id: "call1"
  },
  revision: 1,
  status: "offered",
  put_off: { kind: "in_view" },
  created_at: "2026-10-16T10:00:00.000Z",
  updated_at: "2026-10-16T10:00:00.000Z"
}

const review: TaskProposalReview = {
  expected_revision: 1,
  state: "queued",
  message: "Queued for review.",
  proposal
}

it("encodes stale Memory conflicts and review status through the Task proposals HTTP contract", async () => {
  const services = Layer.mergeAll(
    Layer.succeed(
      TaskProposalStore,
      TaskProposalStore.of({
        get: () => Effect.succeed(proposal),
        memoryScope: () => Effect.succeed("d1"),
        resolve: () => Effect.die("stale Memory must be rejected by the HTTP handler"),
        requestProposalReview: (input: { readonly expectedRevision: number }) =>
          Effect.succeed({ ...review, expected_revision: input.expectedRevision }),
        proposalReviewStatus: () => Effect.succeed(review)
      } as unknown as TaskProposalStore["Service"])
    ),
    Layer.succeed(
      SpaceStore,
      SpaceStore.of({
        get: () =>
          Effect.succeed({
            space_id: "d1",
            archived_at: null,
            page_path: "projects/research/README.md"
          })
      } as unknown as SpaceStore["Service"])
    ),
    Layer.succeed(
      Wiki,
      Wiki.of({
        snapshot: () =>
          Effect.succeed({
            head: "head1",
            pages: [
              {
                resource: { path: "projects/research/README.md", versionId: "memory-current" },
                page: { pageId: "memory-page", lifecycle: "active" }
              }
            ]
          })
      } as unknown as Wiki["Service"])
    )
  )
  const app = HttpApiBuilder.layer(ProposalTestApi).pipe(
    Layer.provide(TaskProposalHandlers.pipe(Layer.provide(services))),
    Layer.provide(HttpServer.layerServices)
  )

  const result = await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(async () => {
          const staleStart = await handler(
            new Request("http://localhost/proposals/p1/resolve", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                expected_revision: 1,
                client_id: "start1",
                decision: "accept",
                space: { kind: "proposed" },
                accepted_in: { kind: "chat", session_id: "session1" }
              })
            })
          )
          const conflict = taskProposalDecoders.conflict(await staleStart.json())

          const pendingStatus = await handler(
            new Request("http://localhost/proposals/p1/recheck", { method: "GET" })
          )
          const decodedStatus = taskProposalDecoders.reviewStatus(await pendingStatus.json())

          const requestedReview = await handler(
            new Request("http://localhost/proposals/p1/recheck", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expected_revision: 1 })
            })
          )
          const decodedReview = taskProposalDecoders.review(await requestedReview.json())
          return {
            staleStart,
            conflict,
            pendingStatus,
            decodedStatus,
            requestedReview,
            decodedReview
          }
        }),
      ({ dispose }) => Effect.promise(dispose)
    )
  )

  expect(result.staleStart.status).toBe(409)
  expect(result.conflict.kind).toBe("source_changed")
  expect(result.pendingStatus.status).toBe(200)
  expect(result.decodedStatus).toEqual(review)
  expect(result.requestedReview.status).toBe(200)
  expect(result.decodedReview).toEqual(review)
})
