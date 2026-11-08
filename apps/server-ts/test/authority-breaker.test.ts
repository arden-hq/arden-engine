import type { JsonObject } from "@arden-hq/loop"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { ApprovalPolicyStore } from "../src/persistence/permissions/approval-policy.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

it("counts a run's rule refusals per tool and its reviews' endings from durable rows", async () => {
  const counts = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const policy = yield* ApprovalPolicyStore
      const session = yield* sessions.create({ name: "Breaker" })
      const run = yield* chat.start({
        sessionId: session.sessionId,
        clientId: "start",
        requestHash: "start",
        assistantMessageId: "assistant",
        message: {
          message_id: "start",
          client_id: "start",
          role: "user",
          content: "Work",
          created_at: "2026-10-06T00:00:00.000Z"
        }
      })
      const call = (toolCallId: string, toolName: string) => ({
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId,
        toolName,
        changesState: false,
        arguments: {}
      })
      const finish = (
        toolCallId: string,
        toolName: string,
        result: { readonly host?: JsonObject; readonly data?: JsonObject }
      ) =>
        Effect.gen(function* () {
          yield* tools.begin(call(toolCallId, toolName))
          yield* tools.complete(call(toolCallId, toolName), {
            content: "done",
            preview: "done",
            is_error: result.host !== undefined,
            retryable: false,
            data: result.data ?? null,
            message_extras: {},
            host: result.host ?? {},
            model_content: []
          })
        })
      const card = (toolCallId: string, note: string | undefined) =>
        Effect.gen(function* () {
          yield* tools.begin(call(toolCallId, "file_write"))
          yield* tools.pause(call(toolCallId, "file_write"), {
            reason: "approval",
            preview: "Write",
            presentation: { title: "Write", fields: [], ...(note === undefined ? {} : { note }) }
          })
        })
      const refused = { host: { refusal: { rule: "boundary" } } }
      yield* finish("r1", "space_task_update", refused)
      yield* finish("r2", "space_task_update", refused)
      yield* finish("ok", "space_task_update", {})
      yield* finish("other", "directives_set", refused)
      const refusals = yield* policy.refusedCalls({
        runId: run.runId,
        toolName: "space_task_update"
      })
      const assessment = {
        verdict: "allow" as const,
        risk: "low" as const,
        authorization: "high" as const,
        authorization_source: "owner" as const,
        policy_category: "none" as const,
        narrowly_scoped: true,
        malicious_prompt_injection: false,
        rationale: "Routine",
        abbreviated: false
      }
      const review = (toolCallId: string, decision: "allow" | "ask") =>
        policy.recordReview({
          runId: run.runId,
          toolCallId,
          sessionId: session.sessionId,
          toolName: "file_write",
          rung: "requirement",
          modelId: "helper",
          outcome:
            decision === "allow"
              ? { decision, decided_by: "outcome", assessment }
              : { decision, decided_by: "timed_out" }
        })
      yield* card("h1", "Review didn't answer in time.")
      yield* review("h1", "ask")
      const waiting = yield* policy.reviewEndings(run.runId)
      yield* review("allowed", "allow")
      const ended = yield* policy.reviewEndings(run.runId)
      return { refusals, waiting, ended }
    }).pipe(
      Effect.provide(
        sqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        )
      )
    )
  )
  expect(counts).toEqual({ refusals: 2, waiting: [], ended: ["passed"] })
})
