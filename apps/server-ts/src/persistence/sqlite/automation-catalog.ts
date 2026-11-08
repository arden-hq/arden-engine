import type { AutomationContextMode, AutomationRun } from "@arden-hq/protocol/automations"
import { haltAutomation } from "./automation-halt.js"
import {
  AutomationRunSchema,
  AutomationRunSkipSchema,
  AutomationToolScopeSchema
} from "@arden-hq/protocol/effect/automations"
import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  AutomationCatalog,
  type AutomationInstructionRevision,
  type AutomationOriginPolicy
} from "../automations/catalog.js"
import { AutomationStoreError } from "../automations/store.js"
import { JobPurposeSchema, type JobPurpose } from "../job-classification.js"
import { decodeJson } from "./json.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import type { SpaceJobRecoveryCursor } from "./space-job-recovery.js"
import { AutomationTriggersSchema, scheduleEffect } from "./automation-schedule.js"
import { resumeAutomation } from "./automation-resume.js"
import { deleteAutomationRow } from "./automation-removal.js"
import { makeAutomationRowReads, type AutomationStoreDeps } from "./automation-rows.js"
import {
  type AutomationRow,
  storeError,
  automationIdEffect,
  skipCorrupt
} from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { inArdenWords } from "../restart-notice.js"
import { outcomeSql, shownRunStatus } from "./automation-run-outcome.js"
import {
  instructionDestination,
  instructionHash,
  matchesInstructionReceipt
} from "./automation-instruction-provenance.js"
import { userAutomationSql } from "./authority-sql.js"

interface AutomationRunRow {
  readonly id: number
  readonly task_id: string
  readonly chat_run_id: string | null
  readonly chat_session_id: string | null
  readonly context_mode: AutomationContextMode
  readonly started_at: string
  readonly ended_at: string | null
  readonly outcome: string | null
  readonly result: string | null
  readonly error: string | null
  readonly skip_json: string | null
}

const PromptAuthorSchema = Schema.Literals(["owner", "agent", "unknown"])
const InstructionSnapshotSchema = Schema.Struct({
  prompt: Schema.String,
  model: Schema.NullOr(Schema.String),
  context_mode: Schema.Literals(["fresh", "continue"]),
  triggers: AutomationTriggersSchema,
  thread_id: Schema.NullOr(Schema.String),
  cooldown_minutes: Schema.NullOr(Schema.Number)
})

const GeneratedDescriptionSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(220))

export const makeAutomationCatalog = ({
  writer,
  sessionEvents,
  rules
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">): Pick<
  AutomationCatalog["Service"],
  | "list"
  | "delegation"
  | "instructionRevision"
  | "originPolicy"
  | "runs"
  | "setGeneratedDescription"
  | "toggle"
  | "delete"
  | "reconcileSpaceJobs"
> => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const { project, findAutomationRow, get } = makeAutomationRowReads({ writer, rules })
  const list = Effect.fn("SqliteAutomationStore.list")(function* () {
    const rows = yield* sql<AutomationRow>`
      SELECT task_id, automation_ref, name, description, description_source,
             prompt, model, context_mode, triggers, trigger_last_id, enabled, created_at, last_run_at,
             next_run_at, last_result, running_since, auto_approve, handler,
             builtin, cooldown_minutes, thread_id, tool_scope, triggers_source,
             purpose, owner_space_id, owner_task_id,
             (SELECT origin_automation_id FROM sessions WHERE session_id = scheduled_tasks.thread_id)
               AS thread_origin_automation_id,
             (SELECT session_id FROM sessions WHERE origin_automation_id = scheduled_tasks.task_id
               AND session_type = 'channel' AND archived_at IS NULL
               ORDER BY started_at DESC LIMIT 1) AS own_chat_id
      FROM scheduled_tasks
      WHERE purpose IN ('user_automation', 'system')
      ORDER BY created_at, task_id
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not list Automations", undefined, cause)
      )
    )
    return yield* skipCorrupt({
      rows,
      decode: (row) => project(row, "list"),
      skipped: (row) => ({ automation_id: row.task_id }),
      what: "an Automation"
    })
  })

  const delegation = Effect.fn("SqliteAutomationStore.delegation")(function* (
    automationId: string
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "get")
    const rows = yield* sql<{ readonly prompt: string; readonly prompt_author: string | null }>`
      SELECT prompt, prompt_author FROM scheduled_tasks
      WHERE task_id = ${validAutomationId} AND builtin = 0 AND ${userAutomationSql()}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError("get", "storage", "Could not load Automation prompt", validAutomationId, cause)
      )
    )
    const row = rows[0]
    if (row === undefined) return null
    const author = yield* Schema.decodeUnknownEffect(PromptAuthorSchema)(
      row.prompt_author ?? "unknown"
    ).pipe(
      Effect.mapError((cause) =>
        storeError(
          "get",
          "corrupt",
          "Stored Automation prompt author is corrupt",
          validAutomationId,
          cause
        )
      )
    )
    return { prompt: row.prompt, author }
  })

  const instructionRevision = Effect.fn("SqliteAutomationStore.instructionRevision")(
    (revisionId: number) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly revision_id: number
          readonly task_id: string
          readonly instruction_json: string
          readonly instruction_hash: string
          readonly prompt_author: string | null
          readonly source_run_id: string | null
          readonly source_tool_call_id: string | null
        }>`
        SELECT revision_id, task_id, instruction_json,
          instruction_hash, prompt_author, source_run_id, source_tool_call_id
        FROM automation_instruction_revisions WHERE revision_id = ${revisionId} LIMIT 1`
        if (row === undefined) return null
        const parsed = yield* Schema.decodeUnknownEffect(InstructionSnapshotSchema)(
          JSON.parse(row.instruction_json) as unknown
        ).pipe(
          Effect.mapError((cause) =>
            storeError(
              "get",
              "corrupt",
              "Stored Automation instruction is corrupt",
              row.task_id,
              cause
            )
          )
        )
        if (instructionHash(row.instruction_json) !== row.instruction_hash)
          return yield* storeError(
            "get",
            "corrupt",
            "Automation instruction digest changed",
            row.task_id
          )
        const author = yield* Schema.decodeUnknownEffect(PromptAuthorSchema)(
          row.prompt_author ?? "unknown"
        ).pipe(
          Effect.mapError((cause) =>
            storeError(
              "get",
              "corrupt",
              "Automation instruction author is corrupt",
              row.task_id,
              cause
            )
          )
        )
        if ((row.source_run_id === null) !== (row.source_tool_call_id === null))
          return yield* storeError(
            "get",
            "corrupt",
            "Automation instruction source is incomplete",
            row.task_id
          )
        if (row.source_run_id !== null && row.source_tool_call_id !== null) {
          const [receipt] = yield* sql<{
            readonly tool_name: string
            readonly status: string
            readonly arguments_json: string
            readonly result_json: string | null
          }>`SELECT tool_name, status, arguments_json, result_json FROM tool_calls
          WHERE run_id = ${row.source_run_id} AND tool_call_id = ${row.source_tool_call_id} LIMIT 1`
          const validName =
            receipt?.tool_name === "automation_create" || receipt?.tool_name === "automation_update"
          if (!validName || receipt.status !== "completed" || receipt.result_json === null)
            return yield* storeError(
              "get",
              "corrupt",
              "Automation write receipt is missing",
              row.task_id
            )
          const result = JSON.parse(receipt.result_json) as unknown
          const args = JSON.parse(receipt.arguments_json) as unknown
          if (
            !matchesInstructionReceipt({
              result,
              args,
              toolName: receipt.tool_name,
              automationRef: yield* automationRefOf(sql, row.task_id),
              destination: yield* instructionDestination(sql, row.task_id, parsed.thread_id),
              instruction: {
                ...parsed,
                triggers: JSON.stringify(parsed.triggers)
              }
            })
          )
            return yield* storeError(
              "get",
              "corrupt",
              "Automation write receipt does not match its instruction",
              row.task_id
            )
        }
        return {
          revisionId: row.revision_id,
          automationId: row.task_id,
          prompt: parsed.prompt,
          author,
          source:
            row.source_run_id === null || row.source_tool_call_id === null
              ? undefined
              : { runId: row.source_run_id, toolCallId: row.source_tool_call_id }
        } satisfies AutomationInstructionRevision
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "get",
                "storage",
                "Could not load Automation instruction",
                undefined,
                cause
              )
        )
      )
  )

  const originPolicy = Effect.fn("SqliteAutomationStore.originPolicy")(function* (
    automationId: string
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "get")
    const rows = yield* sql<{
      readonly tool_scope: string
      readonly auto_approve: number
      readonly purpose: JobPurpose
      readonly handler: string | null
      readonly thread_id: string | null
    }>`
      SELECT tool_scope, auto_approve, handler, purpose, thread_id
      FROM scheduled_tasks
      WHERE task_id = ${validAutomationId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "get",
          "storage",
          "Could not load Automation-origin policy",
          validAutomationId,
          cause
        )
      )
    )
    if (rows[0] === undefined) {
      return yield* storeError(
        "get",
        "not_found",
        "Automation-origin policy does not exist",
        validAutomationId
      )
    }
    const toolScope = yield* Schema.decodeUnknownEffect(AutomationToolScopeSchema)(
      rows[0].tool_scope
    ).pipe(
      Effect.mapError((cause) =>
        storeError(
          "get",
          "corrupt",
          "Stored Automation-origin policy is corrupt",
          validAutomationId,
          cause
        )
      )
    )
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        purpose: JobPurposeSchema,
        handler: Schema.NullOr(Schema.String)
      })
    )({
      purpose: rows[0].purpose,
      handler: rows[0].handler
    }).pipe(
      Effect.mapError((cause) =>
        storeError(
          "get",
          "corrupt",
          "Stored Automation-origin identity is corrupt",
          validAutomationId,
          cause
        )
      )
    )
    return {
      ...identity,
      toolScope,
      autoApprove: rows[0].auto_approve === 1,
      threadId: rows[0].thread_id
    } satisfies AutomationOriginPolicy
  })

  const setGeneratedDescription = Effect.fn("SqliteAutomationStore.setGeneratedDescription")(
    function* (automationId: string, description: string) {
      const validAutomationId = yield* automationIdEffect(automationId, "update")
      const validDescription = yield* Schema.decodeUnknownEffect(GeneratedDescriptionSchema)(
        description
      ).pipe(
        Effect.mapError((cause) =>
          storeError(
            "update",
            "invalid",
            "Invalid generated Automation description",
            validAutomationId,
            cause
          )
        )
      )
      const found = yield* writer
        .transact(
          Effect.gen(function* () {
            const row = yield* findAutomationRow(validAutomationId, "update")
            if (row === null) return false
            yield* sql`
          UPDATE scheduled_tasks
          SET description = ${validDescription}, description_source = 'generated'
          WHERE task_id = ${validAutomationId}
            AND purpose IN ('user_automation', 'system')
            AND (description_source IS NULL OR description_source = 'generated')
        `
            return true
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof AutomationStoreError
              ? cause
              : storeError(
                  "update",
                  "storage",
                  "Could not store generated Automation description",
                  validAutomationId,
                  cause
                )
          )
        )
      return found ? yield* get(validAutomationId) : null
    }
  )

  const toggle = Effect.fn("SqliteAutomationStore.toggle")(function* (automationId: string) {
    const validAutomationId = yield* automationIdEffect(automationId, "toggle")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const row = yield* findAutomationRow(validAutomationId, "toggle")
          if (row === null) return null
          const enabled = row.enabled !== 1
          const triggers = yield* decodeJson(AutomationTriggersSchema, row.triggers).pipe(
            Effect.mapError((cause) =>
              storeError(
                "toggle",
                "corrupt",
                "Stored Automation triggers are corrupt",
                validAutomationId,
                cause
              )
            )
          )
          const schedule = yield* scheduleEffect(rules, triggers, "toggle", validAutomationId)
          if (!enabled) {
            yield* haltAutomation({
              sql,
              sessionEvents,
              automationId: validAutomationId,
              halt: "pause"
            })
            return enabled
          }
          const next = rules.nextRunAt(schedule, yield* Clock.currentTimeMillis)
          yield* resumeAutomation({
            sql,
            automationId: validAutomationId,
            nextRunAt: next === null ? null : iso(next)
          })
          return enabled
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "toggle",
                "storage",
                "Could not toggle Automation",
                validAutomationId,
                cause
              )
        )
      )
  })

  const remove = Effect.fn("SqliteAutomationStore.delete")(function* (automationId: string) {
    const validAutomationId = yield* automationIdEffect(automationId, "delete")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const row = yield* findAutomationRow(validAutomationId, "delete")
          if (row === null) return null
          if (row.builtin === 1) {
            return yield* storeError(
              "delete",
              "conflict",
              "Built-in Automations cannot be deleted",
              validAutomationId
            )
          }
          if (row.running_since !== null) {
            return yield* storeError(
              "delete",
              "conflict",
              "A running Automation cannot be deleted",
              validAutomationId
            )
          }
          yield* deleteAutomationRow({ sql, sessionEvents, automationId: validAutomationId })
          return true as const
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "delete",
                "storage",
                "Could not delete Automation",
                validAutomationId,
                cause
              )
        )
      )
  })

  const runs = Effect.fn("SqliteAutomationStore.runs")(function* (
    automationId: string,
    limit: number
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "runs")
    const validLimit = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
    )(limit).pipe(
      Effect.mapError((cause) =>
        storeError(
          "runs",
          "invalid",
          "Automation run limit must be between 1 and 200",
          validAutomationId,
          cause
        )
      )
    )
    if ((yield* findAutomationRow(validAutomationId, "runs")) === null) return null
    const rows = yield* sql<AutomationRunRow>`
      SELECT run.id, run.task_id, run.chat_run_id, run.chat_session_id, run.context_mode,
             run.started_at, run.ended_at, ${outcomeSql(sql, sql`run`)} AS outcome,
             run.result, run.error,
             CASE WHEN json_extract(run.skip_json, '$.reason') = 'prefilter'
               THEN run.skip_json END AS skip_json
      FROM automation_runs AS run
      WHERE run.task_id = ${validAutomationId}
      ORDER BY run.id DESC
      LIMIT ${validLimit}
    `.pipe(
      Effect.mapError((cause) =>
        storeError("runs", "storage", "Could not list Automation runs", validAutomationId, cause)
      )
    )
    return yield* skipCorrupt({
      rows,
      decode: ({ skip_json: skipJson, outcome, ...row }) =>
        Effect.gen(function* () {
          return {
            status: yield* shownRunStatus(outcome),
            skipped: skipJson === null ? null : yield* decodeJson(AutomationRunSkipSchema, skipJson)
          }
        }).pipe(
          Effect.flatMap(({ status, skipped }) =>
            Schema.decodeUnknownEffect(AutomationRunSchema)({
              ...row,
              status,
              result: inArdenWords(row.result),
              error: inArdenWords(row.error),
              skipped
            })
          ),
          Effect.map((run): AutomationRun => run),
          Effect.mapError((cause) =>
            storeError(
              "runs",
              "corrupt",
              "Stored Automation run is corrupt",
              validAutomationId,
              cause
            )
          )
        ),
      skipped: (row) => ({ automation_id: validAutomationId, run_id: row.id }),
      what: "an Automation run"
    })
  })

  const reconcileSpaceJobs = Effect.fn("SqliteAutomationStore.reconcileSpaceJobs")(function* () {
    const now = iso(yield* Clock.currentTimeMillis)
    let cursor: SpaceJobRecoveryCursor | undefined = { stage: "spaces", after: undefined }
    while (cursor !== undefined) {
      cursor = yield* writer
        .transact(spaceJobs.reconcile(now, cursor))
        .pipe(
          Effect.mapError((cause) =>
            storeError(
              "reconcile_space_jobs",
              "storage",
              "Could not reconcile Space jobs",
              undefined,
              cause
            )
          )
        )
      yield* Effect.yieldNow
    }
  })

  return {
    list,
    delegation,
    instructionRevision,
    originPolicy,
    runs,
    setGeneratedDescription,
    toggle,
    delete: remove,
    reconcileSpaceJobs
  }
}

const automationRefOf = Effect.fn("Automation.automationRefOf")(function* (
  sql: SqlClient.SqlClient,
  automationId: string
) {
  const [row] = yield* sql<{ readonly automation_ref: string }>`
    SELECT automation_ref FROM scheduled_tasks WHERE task_id = ${automationId} LIMIT 1`
  return row?.automation_ref
})
