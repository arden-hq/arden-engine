import { DateTime, Effect, Schema } from "effect"
import { RunTerminalResultSchema } from "@arden-hq/protocol/effect/runs"
import { ChatWriteStore } from "../chat/store.js"
import type { ModelCatalog } from "../../models/catalog.js"
import type { IntelligenceSettingsStore, LimitSettingsStore } from "../settings/store.js"
import {
  automationLimitPercent,
  quotaDecision,
  quotaLimits,
  type PlanReading
} from "../../models/plan-limits.js"
import { parkRunForQuota, runQuotaClass } from "./plan-quota.js"
import type { ChatRules } from "../chat/rules.js"
import { makeChatRecovery } from "./chat-recovery.js"
import { makeChatAdmission } from "./chat-admission.js"
import { makeAgentSpawner } from "./chat-agent-spawn.js"
import { makeChatCheckpoint } from "./chat-checkpoint.js"
import { makeChatQueue } from "./chat-queue.js"
import { makeChatTerminal } from "./chat-terminal.js"
import { makeStopEndedWork } from "./chat-stop-ended.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import { assertRunModelAuthority } from "./run-context.js"
import { sessionTreeRoot } from "./chat-session.js"
import { recordModelRunUsage } from "./run-usage.js"
import { admitModelRequest, readExecutionBudget } from "./execution-budgets.js"
import type { PersistenceDeps } from "./deps.js"
import { iso } from "../../runtime/clock.js"

const makeChatWriteStore = ({
  writer,
  chatEvents,
  sessionEvents,
  catalog,
  intelligence,
  limits,
  rules
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
  readonly catalog: ModelCatalog["Service"]
  readonly intelligence: IntelligenceSettingsStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly rules: ChatRules["Service"]
}): ChatWriteStore["Service"] => {
  const sql = writer.sql
  const recordModelUsage: ChatWriteStore["Service"]["recordModelUsage"] = Effect.fn(
    function* (input) {
      const valid = yield* validateInput(
        Schema.Struct({
          runId: Schema.NonEmptyString,
          sampleId: Schema.NonEmptyString,
          usage: RunTerminalResultSchema.schema.fields.usage
        }),
        input,
        "checkpoint"
      )
      if (
        valid.usage.total !==
        valid.usage.prompt +
          valid.usage.completion +
          valid.usage.cache_read +
          valid.usage.cache_write
      ) {
        return yield* writeError(
          "checkpoint",
          "invalid",
          "Usage total must include all token categories"
        )
      }
      yield* writer
        .transactInteractive(recordModelRunUsage(sql, valid))
        .pipe(Effect.mapError(mapFailure("checkpoint", { runId: valid.runId })))
    }
  )

  const recordLocalInstructions: ChatWriteStore["Service"]["recordLocalInstructions"] = Effect.fn(
    function* (input) {
      const encoded = JSON.stringify(input.sources)
      yield* writer
        .transactInteractive(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly existing: string | null
            }>`SELECT json_extract(metadata_json, '$.local_instructions') AS existing
        FROM chat_runs WHERE run_id = ${input.runId}`
            if (rows[0] === undefined)
              return yield* writeError("checkpoint", "not_found", "Run not found")
            if (rows[0].existing === encoded) return
            yield* sql`UPDATE chat_runs SET metadata_json = json_set(metadata_json,
        '$.local_instructions', json(${encoded})) WHERE run_id = ${input.runId}`
          })
        )
        .pipe(Effect.mapError(mapFailure("checkpoint", { runId: input.runId })))
    }
  )

  return ChatWriteStore.of({
    executionBudget: (runId) =>
      readExecutionBudget(sql, runId).pipe(Effect.mapError(mapFailure("start", { runId }))),
    sessionTreeRoot: (sessionId) => sessionTreeRoot(sql, sessionId, "start"),
    admitModelRequest: Effect.fn("SqliteChatWriteStore.admitModelRequest")(function* (
      runId: string,
      sampleId: string,
      plan?: PlanReading
    ) {
      const settings =
        plan === undefined
          ? undefined
          : yield* limits
              .settings()
              .pipe(
                Effect.mapError((cause) =>
                  writeError("start", "storage", "Could not read the plan limits", { runId, cause })
                )
              )
      const now = yield* DateTime.now
      return yield* writer
        .transactInteractive(
          Effect.gen(function* () {
            if (!sampleId.trim())
              return yield* writeError(
                "start",
                "invalid",
                "Model request identity must not be empty"
              )
            yield* assertRunModelAuthority(sql, runId)
            if (settings !== undefined) {
              const owner = yield* runQuotaClass(sql, runId)
              const decision = quotaDecision({
                reading: plan,
                limits: quotaLimits(settings),
                quotaClass: owner.quotaClass,
                itemLimitPercent: automationLimitPercent(settings, owner.automationId),
                now: DateTime.toEpochMillis(now)
              })
              if (decision.kind === "pause") {
                const until = iso(decision.until)
                yield* parkRunForQuota(sql, {
                  runId,
                  reason: decision.reason,
                  until,
                  timestamp: DateTime.formatIso(now)
                })
                return { kind: "paused", reason: decision.reason, until } as const
              }
            }
            yield* admitModelRequest(sql, runId, sampleId)
            return { kind: "admitted" } as const
          })
        )
        .pipe(Effect.mapError(mapFailure("start", { runId })))
    }),
    recordModelUsage,
    recordLocalInstructions,
    ...makeChatAdmission({
      writer,
      chatEvents,
      sessionEvents,
      catalog,
      intelligence,
      limits,
      rules
    }),
    ...makeChatCheckpoint({ writer, chatEvents, sessionEvents }),
    ...makeChatTerminal({ writer, chatEvents, sessionEvents }),
    ...makeStopEndedWork({ writer, sessionEvents }),
    ...makeAgentSpawner({ writer, chatEvents, sessionEvents, intelligence, rules }),
    ...makeChatQueue({ writer }),
    ...makeChatRecovery({ writer, chatEvents, sessionEvents, intelligence })
  })
}

export { makeChatWriteStore }
