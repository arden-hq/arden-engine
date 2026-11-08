import { randomUUID } from "node:crypto"
import { ServerConfig } from "../config/service.js"
import { Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { ModelStore, ModelStoreError } from "../persistence/models/store.js"
import { ModelProviderService } from "../models/provider.js"
import { meteredModelCall } from "../models/call-usage.js"
import { UsageStore } from "../persistence/usage/store.js"
import { ChatEventStore, ChatEventStoreError } from "../persistence/events/store.js"
import {
  ContextCompactionStore,
  ContextCompactionStoreError,
  type ContextCompactionSnapshot
} from "../persistence/compaction/store.js"
import type {
  StoredMessageEnvelope,
  TranscriptMessageDraft
} from "../persistence/transcript/model.js"
import { estimateHistoryTokens, handoffContent } from "./handoff.js"
import { planCompaction, type CompactionPlan } from "./planner.js"
import { summarizeContext } from "./summarizer.js"
import { SummaryRequests } from "./summary-requests.js"
import { Diagnostics } from "../runtime/diagnostics.js"
import { serializeOperationalCause } from "../runtime/operational-events.js"
import {
  IdleCompactionQueue,
  type IdleCompactionRequest,
  type IdleCompactionCandidate,
  type IdleCompactionDecision
} from "./idle-queue.js"
import { makeIdleCompactor } from "./idle-compactor.js"
import {
  IntelligenceSettingsStore,
  IntelligenceSettingsStoreError
} from "../persistence/settings/store.js"

export type ManualCompactionResult =
  | { readonly status: "no_session"; readonly message: string }
  | {
      readonly status: "nothing_to_compact"
      readonly message: string
      readonly messageCount: number
      readonly beforeTokens: number | null
    }
  | {
      readonly status: "compacted"
      readonly message: string
      readonly beforeTokens: number | null
      readonly beforeMessages: number
      readonly afterMessages: number
      readonly messagesCompressed: number
    }

export interface AutomaticCompactionInput {
  readonly sessionId: string
  readonly runId: string
  readonly inputTokens: number | null
  readonly pendingCallIds?: ReadonlySet<string>
  readonly signal: AbortSignal
}

export class ContextCompactionError extends Schema.TaggedError<ContextCompactionError>()(
  "ContextCompactionError",
  {
    operation: Schema.Literals(["manual", "automatic", "idle"] as const),
    reason: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "unavailable",
      "provider",
      "storage"
    ] as const),
    message: Schema.String,
    sessionId: Schema.optionalKey(Schema.NonEmptyString),
    runId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

const error = (
  operation: "manual" | "automatic" | "idle",
  reason: ContextCompactionError["reason"],
  message: string,
  input?: { readonly sessionId?: string; readonly runId?: string; readonly cause?: unknown }
) =>
  new ContextCompactionError({
    operation,
    reason,
    message,
    ...(input?.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input?.runId === undefined ? {} : { runId: input.runId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause })
  })

const mapStoreError = (
  operation: "manual" | "automatic" | "idle",
  cause: ContextCompactionStoreError
): ContextCompactionError =>
  error(operation, cause.reason === "corrupt" ? "storage" : cause.reason, cause.message, {
    ...(cause.sessionId === undefined ? {} : { sessionId: cause.sessionId }),
    ...(cause.runId === undefined ? {} : { runId: cause.runId }),
    cause
  })

const mapModelError = (
  operation: "manual" | "automatic" | "idle",
  sessionId: string,
  cause: ModelStoreError
): ContextCompactionError => {
  const reason =
    cause.reason === "unavailable" || cause.reason === "storage" ? cause.reason : "invalid"
  return error(operation, reason, cause.message, { sessionId, cause })
}

const mapSettingsError = (
  operation: "manual" | "automatic" | "idle",
  sessionId: string,
  cause: IntelligenceSettingsStoreError
): ContextCompactionError => error(operation, "storage", cause.message, { sessionId, cause })

const mapEventError = (
  sessionId: string,
  runId: string,
  cause: ChatEventStoreError
): ContextCompactionError =>
  error("automatic", "storage", cause.message, {
    sessionId,
    runId,
    cause
  })

const storedInputTokens = (snapshot: {
  readonly metadata: ContextCompactionSnapshot["metadata"]
}): number | null => {
  const value = snapshot.metadata.last_input_tokens
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

const makeHandoff = Effect.fn("ContextCompaction.makeHandoff")(function* (
  snapshot: ContextCompactionSnapshot,
  plan: CompactionPlan,
  summary: string,
  reason: "manual" | "automatic" | "idle",
  compactionId = randomUUID()
): Effect.fn.Return<TranscriptMessageDraft> {
  const createdAt = yield* DateTime.now
  const createdAtText = DateTime.formatIso(createdAt)
  const messageId = compactionId
  const preservedTailIds = plan.tail.map((message) => message.message_id)
  const receipt = {
    compactionId: messageId,
    kind: "session_handoff" as const,
    messageStartId: plan.messageStartId,
    messageEndId: plan.messageEndId,
    ...(plan.parentCompactionId === undefined
      ? {}
      : { parentCompactionId: plan.parentCompactionId }),
    reason,
    messagesBefore: snapshot.messages.length,
    messagesAfter: 1 + preservedTailIds.length,
    preservedTailIds,
    rehydrationState: null
  }
  const content = handoffContent({ ...snapshot, summary })
  const envelope: StoredMessageEnvelope = {
    message_id: messageId,
    role: "assistant",
    created_at: createdAtText,
    content,
    compaction: {
      compaction_id: messageId,
      kind: receipt.kind,
      message_start_id: receipt.messageStartId,
      message_end_id: receipt.messageEndId,
      ...(receipt.parentCompactionId === undefined
        ? {}
        : { parent_compaction_id: receipt.parentCompactionId }),
      reason,
      messages_before: receipt.messagesBefore,
      messages_after: receipt.messagesAfter,
      preserved_tail_ids: [...preservedTailIds],
      rehydration: null
    }
  }
  return {
    messageId,
    role: "assistant",
    envelope,
    clientId: null,
    createdAt,
    searchText: summary,
    compaction: receipt
  }
})

export class ContextCompaction extends Context.Service<
  ContextCompaction,
  {
    readonly rememberRequest: (input: IdleCompactionRequest) => void
    readonly idle: {
      readonly queue: IdleCompactionQueue
      readonly compact: (
        candidate: IdleCompactionCandidate,
        signal: AbortSignal
      ) => Effect.Effect<void, unknown>
    }
    readonly manual: (
      sessionId?: string
    ) => Effect.Effect<ManualCompactionResult, ContextCompactionError>
    readonly automatic: (
      input: AutomaticCompactionInput
    ) => Effect.Effect<ReadonlyArray<StoredMessageEnvelope> | null, ContextCompactionError>
  }
>()("@arden-hq/server/context/ContextCompaction") {
  static readonly layer = Layer.effect(
    ContextCompaction,
    Effect.gen(function* () {
      const requests = new SummaryRequests()
      const config = yield* ServerConfig
      const diagnostics = yield* Diagnostics
      const context = yield* Effect.context<never>()
      const report = (decision: IdleCompactionDecision, cause?: unknown) =>
        void Effect.runForkWith(context)(
          diagnostics.operational({
            code: "context.idle_compaction",
            severity: "info",
            cause: serializeOperationalCause(cause),
            ...decision
          })
        )
      const idleQueue = new IdleCompactionQueue({ delayMs: config.idleCompactionAfterMs, report })
      const modelProvider = yield* ModelProviderService
      const store = yield* ContextCompactionStore
      const models = yield* ModelStore
      const intelligence = yield* IntelligenceSettingsStore
      const events = yield* ChatEventStore
      const usage = yield* UsageStore

      const summarize = Effect.fn("ContextCompaction.summarize")(function* (
        operation: "manual" | "automatic" | "idle",
        snapshot: ContextCompactionSnapshot,
        plan: CompactionPlan,
        maxOutputTokens: number,
        signal?: AbortSignal
      ) {
        const route = modelProvider.current()
        if (route === undefined) {
          return yield* error(
            operation,
            "unavailable",
            "Context compaction provider is not configured",
            {
              sessionId: snapshot.sessionId,
              ...(snapshot.runId === null ? {} : { runId: snapshot.runId })
            }
          )
        }
        const selection =
          snapshot.modelId === null
            ? yield* models
                .selection(snapshot.sessionId)
                .pipe(
                  Effect.mapError((cause) => mapModelError(operation, snapshot.sessionId, cause))
                )
            : { modelId: snapshot.modelId, reasoningEffort: snapshot.reasoningEffort }
        const modelId = selection.modelId
        if (modelId === null) {
          return yield* error(operation, "unavailable", "No Chat model is configured", {
            sessionId: snapshot.sessionId
          })
        }
        const budget = yield* models
          .contextBudget({
            modelId,
            inputTokens: 0,
            messageCount: snapshot.messages.length
          })
          .pipe(Effect.mapError((cause) => mapModelError(operation, snapshot.sessionId, cause)))
        return yield* meteredModelCall(
          usage,
          {
            kind: "compaction",
            owner: { type: "session", sessionId: snapshot.sessionId },
            modelId
          },
          (onResponse) =>
            Effect.tryPromise({
              try: () =>
                summarizeContext({
                  provider: route.provider,
                  model: modelId,
                  reasoningEffort: selection.reasoningEffort,
                  sessionRef: snapshot.sessionRef,
                  sourceSessionRef: snapshot.sourceSessionRef,
                  sourceText: plan.sourceText,
                  ...(plan.priorSummary === undefined ? {} : { priorSummary: plan.priorSummary }),
                  contextWindow: budget.hard_limit,
                  maxOutputTokens,
                  ...(signal === undefined ? {} : { signal }),
                  onResponse,
                  cachedRequest: requests.prefix({
                    sessionId: snapshot.sessionId,
                    provider: route.provider,
                    model: modelId,
                    reasoningEffort: selection.reasoningEffort,
                    source: plan.source,
                    history: snapshot.messages
                  })
                }),
              catch: (cause) =>
                error(operation, "provider", "Could not summarize the active context", {
                  sessionId: snapshot.sessionId,
                  ...(snapshot.runId === null ? {} : { runId: snapshot.runId }),
                  cause
                })
            })
        )
      })

      const commit = Effect.fn("ContextCompaction.commit")(function* (
        operation: "manual" | "automatic" | "idle",
        snapshot: ContextCompactionSnapshot,
        plan: CompactionPlan,
        summary: string,
        compactionId?: string
      ) {
        const handoff = yield* makeHandoff(snapshot, plan, summary, operation, compactionId)
        if (
          Buffer.byteLength(JSON.stringify(handoff.envelope)) >=
          Buffer.byteLength(JSON.stringify(plan.source))
        )
          return yield* error(
            operation,
            "invalid",
            "Compaction did not shrink the replaced history",
            {
              sessionId: snapshot.sessionId
            }
          )
        const committed = yield* store
          .commit({
            sessionId: snapshot.sessionId,
            ...(snapshot.runId === null ? {} : { runId: snapshot.runId }),
            ...(operation === "idle" ? { purpose: "idle" as const } : {}),
            expectedContextGeneration: snapshot.contextGeneration,
            expectedContextVersion: snapshot.contextVersion,
            handoff
          })
          .pipe(Effect.mapError((cause) => mapStoreError(operation, cause)))
        requests.forget(snapshot.sessionId)
        idleQueue.cancel(snapshot.sessionId, "context was compacted")
        return committed
      })

      const manual = Effect.fn("ContextCompaction.manual")(function* (sessionId?: string) {
        if (sessionId !== undefined) idleQueue.cancel(sessionId, "compacted by hand")
        if (sessionId === undefined) {
          return { status: "no_session", message: "Nothing to compact in this chat yet." } as const
        }
        const snapshot = yield* store.snapshot({ sessionId }).pipe(
          Effect.mapError((cause) => mapStoreError("manual", cause)),
          Effect.catchTag("ContextCompactionError", (cause) =>
            cause.reason === "not_found" ? Effect.succeed(null) : Effect.fail(cause)
          )
        )
        if (snapshot === null) {
          return { status: "no_session", message: "Nothing to compact in this chat yet." } as const
        }
        const controls = yield* intelligence
          .settings()
          .pipe(Effect.mapError((cause) => mapSettingsError("manual", snapshot.sessionId, cause)))
        const beforeTokens = storedInputTokens(snapshot)
        const plan = planCompaction(snapshot.messages, controls.compactionKeepRatio)
        if (plan === null) {
          return {
            status: "nothing_to_compact",
            message: `Nothing to compact (${snapshot.messages.length} messages)`,
            messageCount: snapshot.messages.length,
            beforeTokens
          } as const
        }
        const summary = yield* summarize("manual", snapshot, plan, controls.summaryMaxTokens)
        const committed = yield* commit("manual", snapshot, plan, summary)
        return {
          status: "compacted",
          message: `Compacted ${committed.messagesBefore} → ${committed.messagesAfter} messages`,
          beforeTokens,
          beforeMessages: committed.messagesBefore,
          afterMessages: committed.messagesAfter,
          messagesCompressed: plan.source.length
        } as const
      })

      const automatic = Effect.fn("ContextCompaction.automatic")(function* (
        input: AutomaticCompactionInput
      ) {
        idleQueue.cancel(input.sessionId, "run is compacting itself")
        const measured = yield* store
          .measure({
            sessionId: input.sessionId,
            runId: input.runId
          })
          .pipe(Effect.mapError((cause) => mapStoreError("automatic", cause)))
        const reported = input.inputTokens ?? storedInputTokens(measured)
        const loaded =
          reported === null
            ? yield* store
                .snapshot({ sessionId: input.sessionId, runId: input.runId })
                .pipe(Effect.mapError((cause) => mapStoreError("automatic", cause)))
            : null
        const inputTokens =
          reported ?? (loaded === null ? 0 : estimateHistoryTokens(loaded.messages))
        const budget = yield* models
          .contextBudget({
            modelId: measured.modelId,
            inputTokens,
            messageCount: measured.messageCount
          })
          .pipe(Effect.mapError((cause) => mapModelError("automatic", input.sessionId, cause)))
        if (inputTokens < budget.compaction_trigger) return null
        const snapshot =
          loaded ??
          (yield* store
            .snapshot({ sessionId: input.sessionId, runId: input.runId })
            .pipe(Effect.mapError((cause) => mapStoreError("automatic", cause))))

        const controls = yield* intelligence
          .settings()
          .pipe(Effect.mapError((cause) => mapSettingsError("automatic", input.sessionId, cause)))
        const plan = planCompaction(
          snapshot.messages,
          controls.compactionKeepRatio,
          input.pendingCallIds
        )
        if (plan === null) return null
        const compactionId = randomUUID()
        const messagesBefore = snapshot.messages.length
        yield* events
          .append({
            sessionId: input.sessionId,
            events: [
              {
                event: {
                  type: "compaction_started",
                  run_id: input.runId,
                  compaction_id: compactionId,
                  messages_before: messagesBefore
                },
                runId: input.runId
              }
            ]
          })
          .pipe(Effect.mapError((cause) => mapEventError(input.sessionId, input.runId, cause)))

        const compact = Effect.gen(function* () {
          const summary = yield* summarize(
            "automatic",
            snapshot,
            plan,
            controls.summaryMaxTokens,
            input.signal
          )
          return yield* commit("automatic", snapshot, plan, summary, compactionId)
        })
        const committed = yield* compact.pipe(
          Effect.onExit((exit) => {
            const succeeded = Exit.isSuccess(exit)
            let outcome: "succeeded" | "failed" | "cancelled"
            if (succeeded) outcome = "succeeded"
            else if (input.signal.aborted) outcome = "cancelled"
            else outcome = "failed"
            return events
              .append({
                sessionId: input.sessionId,
                events: [
                  {
                    event: {
                      type: "compaction_finished",
                      run_id: input.runId,
                      compaction_id: compactionId,
                      outcome,
                      messages_before: messagesBefore,
                      messages_after: succeeded ? exit.value.messagesAfter : messagesBefore
                    },
                    runId: input.runId,
                    admission: "detached" as const
                  }
                ]
              })
              .pipe(
                Effect.mapError((cause) => mapEventError(input.sessionId, input.runId, cause)),
                Effect.asVoid
              )
          })
        )
        return committed.messages
      })

      const compactIdle = yield* makeIdleCompactor({
        report,
        commit: (snapshot, plan, summary) => commit("idle", snapshot, plan, summary)
      })
      return ContextCompaction.of({
        idle: { queue: idleQueue, compact: compactIdle },
        manual,
        automatic,
        rememberRequest: (input) => {
          const saved = requests.remember(input)
          idleQueue.remember({ ...input, ...saved })
        }
      })
    })
  )
}
