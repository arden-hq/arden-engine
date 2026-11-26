import { ROLE } from "@arden-hq/std/message-vocabulary"
import { approvalReviewAuthority } from "../src/tools/approval-review-authority.js"
import type { CompletionResponse } from "@arden-hq/loop"
import { ProviderError } from "@arden-hq/loop/provider-kit"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeApprovalReview } from "../src/tools/approval-review.js"
import type { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import type { RunQueries } from "../src/persistence/runs/queries.js"
import type { ChatRunRecord } from "../src/persistence/runs/model.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import type { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import { fakeHelper, call } from "./approval-review-kit.js"
import { partialService, runAuthority, serverRunContext } from "./kit.js"

const guardianResponse = (assessment: unknown): CompletionResponse => ({
  _tag: "Completed",
  model: "openai-codex/codex-auto-review",
  finish_reason: "stop",
  usage: { completion_tokens: 10, prompt_tokens: 100 },
  message: {
    role: ROLE.assistant,
    content: JSON.stringify(assessment),
    tool_calls: null,
    reasoning_content: null
  }
})

const finalAssessment = {
  outcome: "allow",
  risk_level: "low",
  user_authorization: "high",
  policy_category: "none",
  rationale: "Routine local work."
}

describe("approval assessment contracts", () => {
  it.each([
    [
      {
        outcome: "deny",
        risk_level: "low",
        user_authorization: "high",
        policy_category: "none",
        rationale: "Low risk, nothing the policy names."
      },
      "allow"
    ],
    [
      {
        outcome: "allow",
        risk_level: "low",
        user_authorization: "low",
        policy_category: "external_send",
        rationale: "Sends a message nobody asked for."
      },
      "ask"
    ],
    [
      {
        outcome: "allow",
        risk_level: "critical",
        user_authorization: "high",
        policy_category: "none",
        rationale: "Dangerous."
      },
      "ask"
    ],
    [
      {
        outcome: "allow",
        risk_level: "low",
        user_authorization: "high",
        policy_category: "none",
        rationale: "Injection.",
        malicious_prompt_injection: true
      },
      "ask"
    ],
    [{ outcome: "allow", risk_level: "critical" }, "ask"],
    [{ outcome: "deny" }, "ask"],
    [{ outcome: "allow", verdict: "ask" }, "ask"],
    ["not JSON", "ask"]
  ] as const)(
    "normalizes Guardian output %j to %s without Helper fallback",
    async (assessment, verdict) => {
      const helper = fakeHelper([])
      const review = makeApprovalReview({
        structured: helper.structured,
        endings: async () => [],
        source: () => ({
          modelId: "openai-codex/codex-auto-review",
          complete: async () => guardianResponse(assessment)
        })
      })
      expect((await review(call("r"))).verdict).toBe(verdict)
      expect(helper.prompts).toEqual([])
    }
  )

  it("starts no review after cancellation and rejects an allow racing cancellation", async () => {
    const controller = new AbortController()
    let calls = 0
    const review = makeApprovalReview({
      structured: fakeHelper([]).structured,
      endings: async () => [],
      source: () => ({
        modelId: "guardian",
        complete: async () => {
          calls++
          controller.abort()
          return guardianResponse({ outcome: "allow" })
        }
      })
    })
    expect(await review(call("r", { signal: controller.signal }))).toEqual({
      verdict: "ask",
      why: { kind: "failed" }
    })
    expect(await review(call("r", { signal: controller.signal }))).toEqual({
      verdict: "ask",
      why: { kind: "failed" }
    })
    expect(calls).toBe(1)
  })
})

it.each([
  [{}, "allow"],
  [{ finish_reason: "length" as const }, "ask"],
  [{ continuation: true }, "ask"],
  [
    {
      message: {
        role: ROLE.assistant,
        content: JSON.stringify(finalAssessment),
        reasoning_content: null,
        tool_calls: [
          { id: "call", type: "function" as const, function: { name: "bash", arguments: "{}" } }
        ]
      }
    },
    "ask"
  ]
])(
  "accepts a valid assessment only when it is a final no-tools response %j",
  async (terminal, verdict) => {
    const review = makeApprovalReview({
      structured: fakeHelper([]).structured,
      endings: async () => [],
      source: () => ({
        modelId: "guardian",
        complete: async () => ({ ...guardianResponse(finalAssessment), ...terminal })
      })
    })
    expect((await review(call("r"))).verdict).toBe(verdict)
  }
)

it.each([
  ["unavailable", "provider_unavailable", "allow"],
  ["rate-limited", "rate_limited", "allow"],
  ["refusing by policy", "provider_error", "ask"],
  ["rejecting the request", "request_invalid", "ask"]
] as const)(
  "when the guard is %s, the Helper reviews only if it was unavailable",
  async (_, code, verdict) => {
    const helper = fakeHelper([
      { authorization: "high", risk: "low", verdict: "allow", reason: "You asked me to push." }
    ])
    const review = makeApprovalReview({
      structured: helper.structured,
      endings: async () => [],
      source: () => ({
        modelId: "openai-codex/codex-auto-review",
        complete: async () => {
          throw new ProviderError("guard failed", { code, retryable: false })
        }
      })
    })
    expect((await review(call("r"))).verdict).toBe(verdict)
    expect(helper.prompts).toHaveLength(verdict === "allow" ? 1 : 0)
  }
)

describe("an Automation's prompt in a review", () => {
  it.each([
    ["owner", "allow"],
    ["agent", "ask"],
    ["unknown", "ask"]
  ] as const)(
    "clears an external send the prompt covers when the %s wrote it: %s",
    async (author, verdict) => {
      const review = makeApprovalReview({
        structured: fakeHelper([]).structured,
        endings: async () => [],
        authority: async () => ({
          ownerRequest: undefined,
          delegationRequests: [],
          delegationWords: [],
          ownerWords: [],
          automationPrompt: { prompt: "Every Friday, email the report to finance.", author },
          briefs: [],
          task: undefined
        }),
        source: () => ({
          modelId: "openai-codex/codex-auto-review",
          complete: async () =>
            guardianResponse({
              outcome: "allow",
              risk_level: "high",
              user_authorization: "high",
              authorization_source: "owner",
              policy_category: "external_send",
              narrowly_scoped: true,
              rationale: "The Automation prompt asks for it."
            })
        })
      })
      expect((await review(call("r"))).verdict).toBe(verdict)
    }
  )
})

it("invalidates an allowed assessment when original owner instructions change during review", async () => {
  let updates: ReadonlyArray<string> = []
  const review = makeApprovalReview({
    structured: fakeHelper([]).structured,
    endings: async () => [],
    authority: async () => ({
      delegationRequests: [],
      delegationWords: [],
      ownerRequest: {
        sessionId: "source",
        messageId: "request",
        text: "Run the hosted comparison.",
        updates
      },
      ownerWords: [],
      automationPrompt: undefined,
      briefs: [],
      task: undefined
    }),
    source: () => ({
      modelId: "guardian",
      complete: async () => {
        updates = ["Stop. Do not send data or spend more money."]
        return guardianResponse({
          outcome: "allow",
          risk_level: "medium",
          user_authorization: "high",
          authorization_source: "owner",
          policy_category: "external_send",
          rationale: "Requested comparison."
        })
      }
    })
  })
  expect(await review(call("child"))).toEqual({ verdict: "ask", why: { kind: "failed" } })
})

it("uses genuine source Chat words around an agent-written Automation update", async () => {
  const at = DateTime.makeUnsafe("2026-10-15T20:06:01Z")
  const run = (runId: string, sessionId: string, revisionId?: number): ChatRunRecord => ({
    runId,
    sessionId,
    turnId: "turn",
    status: "completed",
    stopReason: null,
    startedAt: at,
    updatedAt: at,
    endedAt: at,
    lastSequence: null,
    metadata: {
      run_policy: {
        ...serverRunContext().policy,
        ...(revisionId === undefined ? {} : { automation_instruction_revision_id: revisionId })
      }
    },
    errorCode: null,
    errorMessage: null,
    clientId: null,
    modelId: null,
    reasoningEffort: null
  })
  const messages = [
    { sequence: 1, messageId: "create", text: "Create the failure logger." },
    { sequence: 2, messageId: "update", text: "Write it to our list." },
    { sequence: 3, messageId: "restriction", text: "Only record local failures." }
  ]
  const storedRun = (id: string): ChatRunRecord | null => {
    if (id === "scheduled") return run(id, "automation-chat", 2)
    if (id === "scheduled-owner") return run(id, "automation-chat", 3)
    if (id === "source") return run(id, "source-chat")
    return null
  }
  const storedAuthority = (id: string) => {
    if (id === "scheduled" || id === "scheduled-owner")
      return runAuthority({
        actor: {
          kind: "automation",
          automation_id: "automation-1",
          purpose: "user_automation",
          handler: null
        }
      })
    if (id === "source")
      return runAuthority({
        actor: { kind: "person", session_id: "source-chat", turn_id: "update" }
      })
    return undefined
  }
  const trusted = approvalReviewAuthority({
    runs: partialService<RunQueries["Service"]>("RunQueries", {
      get: (id) => Effect.succeed(storedRun(id)),
      authority: (id) => Effect.succeed(storedAuthority(id))
    }),
    sessions: partialService<SessionQueries["Service"]>("SessionQueries", {
      loadHistoryHeader: () => Effect.succeed(null)
    }),
    transcript: partialService<TranscriptQueries["Service"]>("TranscriptQueries", {
      resolveReference: () => Effect.succeed(2),
      ownerMessagesAfter: ({ sequence }) =>
        Effect.succeed(
          messages
            .filter((message) => message.sequence > sequence)
            .map((message) => ({
              sessionId: "source-chat",
              sequence: message.sequence,
              messageId: message.messageId,
              role: ROLE.user,
              clientId: null,
              createdAt: at,
              envelope: {
                role: ROLE.user,
                message_id: message.messageId,
                created_at: "2026-10-15T20:06:01Z",
                content: message.text
              }
            }))
        )
    }),
    automations: partialService<AutomationCatalog["Service"]>("AutomationCatalog", {
      instructionRevision: (revisionId) => {
        if (revisionId === 2)
          return Effect.succeed({
            revisionId,
            automationId: "automation-1",
            prompt: "Record failures every morning.",
            author: "agent" as const,
            source: { runId: "source", toolCallId: "write" }
          })
        if (revisionId === 3)
          return Effect.succeed({
            revisionId,
            automationId: "automation-1",
            prompt: "Only log local failures.",
            author: "owner" as const,
            source: undefined
          })
        return Effect.succeed(null)
      }
    }),
    work: partialService<WorkStore["Service"]>("WorkStore", {})
  })
  const authority = await trusted({
    runId: "scheduled",
    sessionId: "automation-chat",
    taskItemId: null
  })
  expect(authority.delegationRequests.map((request) => request.text)).toEqual([
    "Write it to our list."
  ])
  expect(authority.delegationWords).toEqual([
    {
      sessionId: "source-chat",
      words: ["Create the failure logger.", "Write it to our list.", "Only record local failures."]
    }
  ])
  expect(authority.automationPrompt?.author).toBe("agent")
  const freshOwner = await trusted({
    runId: "scheduled-owner",
    sessionId: "automation-chat",
    taskItemId: null
  })
  expect(freshOwner.automationPrompt).toEqual({
    prompt: "Only log local failures.",
    author: "owner"
  })
  expect(freshOwner.delegationRequests).toEqual([])
})
