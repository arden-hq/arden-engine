import { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import { Effect } from "effect"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { ModelProviderService } from "../models/provider.js"
import { meteredModelCall } from "../models/call-usage.js"
import { UsageStore } from "../persistence/usage/store.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { WorkStore } from "../persistence/work/store.js"
import { makeApprovalReview, type ApprovalReview } from "./approval-review.js"
import { approvalReviewAuthority } from "./approval-review-authority.js"
import { RunQueries } from "../persistence/runs/queries.js"

export const makeRegistryApprovalReview = ({
  structured,
  policy,
  runs,
  sessions,
  transcript,
  automations,
  work,
  modelProvider,
  usageStore
}: {
  readonly structured: StructuredCompletion["Service"]
  readonly policy: ApprovalPolicyStore["Service"]
  readonly runs: RunQueries["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly transcript: TranscriptQueries["Service"]
  readonly automations: AutomationCatalog["Service"]
  readonly work: WorkStore["Service"]
  readonly modelProvider: ModelProviderService["Service"]
  readonly usageStore: UsageStore["Service"]
}): ApprovalReview =>
  makeApprovalReview({
    structured,
    endings: (runId) => Effect.runPromise(policy.reviewEndings(runId)),
    record: (record) => Effect.runPromise(policy.recordReview(record)),
    authority: approvalReviewAuthority({ runs, sessions, transcript, automations, work }),
    source: (sessionId) => {
      const reviewer = modelProvider.current()?.approvalReview
      if (reviewer === undefined) return undefined
      return {
        modelId: reviewer.modelId,
        complete: (input) =>
          Effect.runPromise(
            meteredModelCall(
              usageStore,
              {
                kind: "helper_review",
                owner: { type: "session", sessionId },
                modelId: reviewer.modelId
              },
              (onResponse) =>
                Effect.tryPromise(async () => {
                  const response = await reviewer.complete(input)
                  onResponse(response)
                  return response
                })
            ),
            { signal: input.signal }
          )
      }
    }
  })
