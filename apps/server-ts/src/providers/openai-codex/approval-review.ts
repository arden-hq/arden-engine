import { ToolChoice } from "@arden-hq/loop"
import type { ApprovalReviewSource } from "../../models/provider.js"
import {
  makeOpenAiResponsesProvider,
  type OpenAiResponsesProviderOptions
} from "../openai-responses/index.js"

export const makeCodexApprovalReview = (
  options: OpenAiResponsesProviderOptions
): ApprovalReviewSource => {
  const provider = makeOpenAiResponsesProvider({
    ...options,
    headers: { ...options.headers, "x-codex-guardian": "reviewer" },
    omitMaxOutputTokens: true
  })
  const modelId = "openai-codex/codex-auto-review"
  return {
    modelId,
    complete: async ({ system, user, responseFormat, signal }) => {
      signal.throwIfAborted()
      for await (const item of await provider.stream({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        model: modelId,
        reasoningEffort: "low",
        tools: [],
        deferredTools: [],
        toolChoice: ToolChoice.NONE,
        responseFormat,
        renderInteraction: () => {
          throw new Error("Approval review has no interactions")
        },
        signal
      })) {
        if (item._tag !== "Completed") continue
        return item
      }
      throw new Error("Approval review completed without an assessment")
    }
  }
}
