import { DateTime, Effect, Schema } from "effect"
import { disposableForkSql } from "../schema/fork-disposition.js"
import { REVIEW_BREAKER, reviewEnding, type ReviewEnding } from "../../execution/review.js"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { narrowerApprovalMode, type ApprovalMode } from "@arden-hq/protocol/permissions"
import { RunCapabilitySchema } from "../../execution/policy.js"
import {
  approvalSources,
  rootOf,
  type ApprovalSource,
  type RunAuthority,
  type SingleApprovalSource
} from "../../execution/authority.js"
import {
  ApprovalModeSchema,
  ApprovalPolicyError,
  ApprovalPolicyStore,
  type ApprovalReviewRecord,
  type AuthorityLiveState,
  type SessionPermission
} from "../permissions/approval-policy.js"
import { readRunAuthority } from "./run-authority.js"
import { runAuthorityState, type RunAuthorityState } from "./run-context.js"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"
import type { PersistenceDeps } from "./deps.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import {
  defaultModeSql,
  readDefaultApprovalMode,
  writeDefaultApprovalMode
} from "./default-approval-mode.js"

const noApprovalForAuthority = Effect.fn("ApprovalPolicy.noApprovalForAuthority")(function* (
  sql: SqlClient.SqlClient,
  authority: RunAuthority
) {
  for (const source of approvalSources(authority.approval.follows)) {
    if (source.kind !== "chat") continue
    const rows = yield* sql<{ readonly disposable: number }>`SELECT EXISTS(
        SELECT 1 FROM session_fork_requests fork
        WHERE fork.child_session_id = ${source.session_id}
          AND ${sql.literal(disposableForkSql("fork"))}
      ) AS disposable`
    if (rows[0]?.disposable === 1) return true
  }
  return false
})

export const noApprovalForRun = Effect.fn("ApprovalPolicy.noApprovalForRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  currentAuthority?: RunAuthority
) {
  const authority = currentAuthority ?? (yield* readRunAuthority(sql, runId))
  if (authority !== undefined && (yield* noApprovalForAuthority(sql, authority))) return true
  const runs = yield* sql<{
    readonly session_id: string
    readonly session_type: string
    readonly disposable: number
  }>`
    SELECT run.session_id, session.session_type, EXISTS(
      SELECT 1 FROM session_fork_requests AS fork
      WHERE fork.child_session_id = run.session_id
        AND ${sql.literal(disposableForkSql("fork"))}
    ) AS disposable FROM chat_runs AS run
    JOIN sessions AS session ON session.session_id = run.session_id
    WHERE run.run_id = ${runId}`
  const run = runs[0]
  if (run === undefined) return false
  if (run.disposable === 1) return true
  if (run.session_type !== "agent") return false
  const lineage = yield* sql.unsafe<{
    readonly session_id: string
    readonly session_type: string
    readonly edge_valid: number
  }>(decisionLineageSql("?"), [run.session_id])
  const invalidDelegation =
    lineage.length === 0 ||
    lineage.every((node) => node.session_type === "agent") ||
    lineage.some((node) => node.edge_valid !== 1)
  if (invalidDelegation) return false
  const sessionIds = lineage.map((node) => node.session_id)
  if (sessionIds.length === 0) return false
  const rows = yield* sql<{ readonly disposable: number }>`SELECT EXISTS(
      SELECT 1 FROM session_fork_requests AS fork
      WHERE fork.child_session_id IN ${sql.in(sessionIds)}
        AND ${sql.literal(disposableForkSql("fork"))}
    ) AS disposable`
  return rows[0]?.disposable === 1
})

const storage = (cause: unknown) =>
  cause instanceof ApprovalPolicyError
    ? cause
    : new ApprovalPolicyError({
        reason: "storage",
        message: "Could not read or update permission settings",
        cause
      })
const invalid = (message: string) => new ApprovalPolicyError({ reason: "invalid", message })

export const makeApprovalPolicyStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): ApprovalPolicyStore["Service"] => {
  const sql = writer.sql
  const session = Effect.fn("ApprovalPolicy.session")(function* (
    sessionId: string
  ): Effect.fn.Return<SessionPermission, unknown> {
    const rows = yield* sql<{
      readonly session_type: string
      readonly origin_automation_id: string | null
      readonly parent_session_id: string | null
      readonly purpose: string | null
      readonly space_id: string | null
      readonly mode: string | null
      readonly tool_scope: string | null
      readonly auto_approve: number | null
      readonly space_mode: string | null
      readonly disposable: number
    }>`SELECT s.session_type, s.origin_automation_id, s.parent_session_id, s.space_id,
      a.purpose,
      COALESCE(json_extract(s.metadata, '$.approval_mode'), (SELECT COALESCE(
        json_extract(r.metadata_json, '$.run_policy.approval_mode'),
        CASE WHEN json_extract(r.metadata_json, '$.run_policy.auto_approve') = 1 THEN 'allow' ELSE 'ask' END)
        FROM chat_runs r WHERE r.session_id = s.session_id ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1),
        ${defaultModeSql(sql)}) AS mode,
      a.tool_scope, a.auto_approve,
      EXISTS(SELECT 1 FROM session_fork_requests fork
        WHERE fork.child_session_id = s.session_id
          AND ${sql.literal(disposableForkSql("fork"))}) AS disposable,
      CASE WHEN a.purpose != 'user_automation' AND a.owner_space_id IS NOT NULL
        THEN ${defaultModeSql(sql)} END AS space_mode
      FROM sessions s LEFT JOIN scheduled_tasks a ON a.task_id = s.origin_automation_id
      WHERE s.session_id = ${sessionId}`
    const row = rows[0]
    if (!row)
      return yield* new ApprovalPolicyError({ reason: "not_found", message: "Chat not found" })
    if (row.disposable === 1) return { kind: "inherited", approval_mode: "ask" }
    if (row.origin_automation_id !== null && isUserAutomationPurpose(row.purpose)) {
      const mode = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(
        row.mode ?? DEFAULT_APPROVAL_MODE
      )
      if (row.parent_session_id !== null) return { kind: "inherited", approval_mode: mode }
      return yield* chatPermission(mode)
    }
    if (row.origin_automation_id !== null) {
      if (row.tool_scope === null || row.auto_approve === null)
        return yield* invalid("Automation permission settings are unavailable")
      const spaceMode = yield* Schema.decodeUnknownEffect(Schema.NullOr(ApprovalModeSchema))(
        row.space_mode
      )
      return {
        kind: "automation",
        automation_id: row.origin_automation_id,
        tool_scope: row.tool_scope,
        auto_approve: row.auto_approve === 1,
        ...(spaceMode === null ? {} : { approval_mode: spaceMode })
      }
    }
    if (row.session_type !== "chat") {
      if (row.session_type !== "agent") return { kind: "inherited" }
      const [latest] = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM chat_runs WHERE session_id = ${sessionId}
        ORDER BY started_at DESC, run_id DESC LIMIT 1
      `
      if (latest === undefined) return { kind: "inherited" }
      const authority = yield* readRunAuthority(sql, latest.run_id)
      if (authority === undefined) return { kind: "inherited" }
      const current = yield* live({ runId: latest.run_id, authority })
      return current.state === "active"
        ? { kind: "inherited", approval_mode: current.mode }
        : { kind: "inherited" }
    }
    const mode = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(
      row.mode ?? DEFAULT_APPROVAL_MODE
    )
    return yield* chatPermission(mode)
  }, Effect.mapError(storage))

  const setSession = Effect.fn("ApprovalPolicy.setSession")(function* (input: {
    readonly sessionId: string
    readonly mode?: typeof ApprovalModeSchema.Type
  }) {
    if (input.mode === undefined) return yield* invalid("No permission change was provided")
    const mode = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(input.mode).pipe(
      Effect.mapError(() => invalid("Invalid approval mode"))
    )
    return yield* writer.transact(
      Effect.gen(function* () {
        const current = yield* session(input.sessionId)
        if (current.kind !== "chat")
          return yield* invalid("Permissions are managed by this Chat's owner")
        yield* sql`UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.approval_mode', ${mode})
          WHERE session_id = ${input.sessionId}`
        return yield* session(input.sessionId)
      })
    )
  }, Effect.mapError(storage))

  const live = Effect.fn("ApprovalPolicy.live")(function* (input: {
    readonly runId: string
    readonly authority: RunAuthority
  }): Effect.fn.Return<AuthorityLiveState, unknown> {
    const follows = input.authority.approval.follows
    const owner = input.authority.owns.automation_id
    const job =
      owner !== null &&
      ["automation", "task_worker", "space_review"].includes(rootOf(input.authority.actor))
    const rows = yield* sql<{
      readonly state: RunAuthorityState
      readonly purpose: string | null
      readonly tool_scope: string | null
    }>`SELECT ${runAuthorityState(sql, sql`r.metadata_json`, sql`r.run_id`)} AS state,
      job.purpose, job.tool_scope
      FROM chat_runs r LEFT JOIN scheduled_tasks job ON ${job ? 1 : 0} = 1 AND job.task_id = ${owner}
      WHERE r.run_id = ${input.runId}`
    const row = rows[0]
    if (!row)
      return yield* new ApprovalPolicyError({ reason: "not_found", message: "Run not found" })
    const mode = yield* currentMode(follows)
    const noApproval = yield* noApprovalForRun(sql, input.runId, input.authority)
    const currentScope =
      row.purpose === null || isUserAutomationPurpose(row.purpose) || row.tool_scope === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(RunCapabilitySchema)(row.tool_scope)
    return { state: row.state, mode, noApproval, currentScope }
  }, Effect.mapError(storage))

  const settingMode = (follows: SingleApprovalSource): Statement.Fragment => {
    switch (follows.kind) {
      case "chat":
        return sql`COALESCE((SELECT json_extract(metadata, '$.approval_mode') FROM sessions
          WHERE session_id = ${follows.session_id}), ${defaultModeSql(sql)})`
      case "space_thread":
        return defaultModeSql(sql)
      case "automation":
        return sql`(SELECT CASE WHEN auto_approve = 1 THEN 'allow' ELSE 'ask' END
          FROM scheduled_tasks WHERE task_id = ${follows.automation_id})`
    }
  }

  const currentMode = Effect.fn("ApprovalPolicy.currentMode")(function* (follows: ApprovalSource) {
    const modes = yield* Effect.forEach(approvalSources(follows), (source) =>
      sql<{ readonly mode: string | null }>`SELECT ${settingMode(source)} AS mode`.pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(ApprovalModeSchema)(rows[0]?.mode ?? defaultMode(source))
        )
      )
    )
    return modes.reduce(narrowerApprovalMode)
  })

  const refusedCalls = Effect.fn("ApprovalPolicy.refusedCalls")(function* (input: {
    readonly runId: string
    readonly toolName: string
  }) {
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM tool_calls
      WHERE run_id = ${input.runId} AND tool_name = ${input.toolName}
        AND json_extract(result_json, '$.host.refusal') IS NOT NULL`
    return rows[0]?.count ?? 0
  }, Effect.mapError(storage))

  const reviewEndings = Effect.fn("ApprovalPolicy.reviewEndings")(function* (runId: string) {
    const rows = yield* sql<{
      readonly decision: string
      readonly decided_by: string
      readonly answer: string | null
    }>`SELECT review.decision, review.decided_by, COALESCE(card.status, inbox.status) AS answer
      FROM approval_reviews AS review
      LEFT JOIN tool_approvals AS card
        ON card.run_id = review.run_id AND card.tool_call_id = review.tool_call_id
      LEFT JOIN deferred_tool_calls AS inbox
        ON inbox.run_id = review.run_id AND inbox.tool_call_id = review.tool_call_id
      WHERE review.run_id = ${runId}
      ORDER BY review.reviewed_at DESC, review.tool_call_id DESC
      LIMIT ${REVIEW_BREAKER.window}`
    return rows.flatMap((row): ReadonlyArray<ReviewEnding> => {
      const ending = reviewEnding(row.decision, row.decided_by, row.answer)
      return ending === undefined ? [] : [ending]
    })
  }, Effect.mapError(storage))

  const recordReview = Effect.fn("ApprovalPolicy.recordReview")(function* (
    record: ApprovalReviewRecord
  ) {
    const at = DateTime.formatIso(yield* DateTime.now)
    const { outcome } = record
    const assessment = "assessment" in outcome ? outcome.assessment : undefined
    const flag = (value: boolean | undefined) => (value === undefined ? null : Number(value))
    yield* writer.run(
      sql`INSERT OR REPLACE INTO approval_reviews (
        run_id, tool_call_id, session_id, tool_name, reviewed_at, rung, model_id,
        decision, decided_by, verdict, risk, user_authorization, authorization_source,
        policy_category, narrowly_scoped, malicious_prompt_injection, abbreviated, rationale
      ) VALUES (
        ${record.runId}, ${record.toolCallId}, ${record.sessionId}, ${record.toolName}, ${at},
        ${record.rung}, ${record.modelId ?? null}, ${outcome.decision}, ${outcome.decided_by},
        ${assessment?.verdict ?? null}, ${assessment?.risk ?? null},
        ${assessment?.authorization ?? null}, ${assessment?.authorization_source ?? null},
        ${assessment?.policy_category ?? null}, ${flag(assessment?.narrowly_scoped)},
        ${flag(assessment?.malicious_prompt_injection)}, ${flag(assessment?.abbreviated)},
        ${assessment?.rationale ?? null}
      )`
    )
  }, Effect.mapError(storage))

  const mainMode = Effect.fn("ApprovalPolicy.defaultMode")(function* () {
    return yield* readDefaultApprovalMode(sql)
  }, Effect.mapError(storage))

  const setMainMode = Effect.fn("ApprovalPolicy.setDefaultMode")(function* (mode: ApprovalMode) {
    const valid = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(mode).pipe(
      Effect.mapError(() => invalid("Invalid approval mode"))
    )
    yield* writer.run(writeDefaultApprovalMode(sql, valid))
    return valid
  }, Effect.mapError(storage))

  return ApprovalPolicyStore.of({
    session,
    setSession,
    defaultMode: mainMode,
    setDefaultMode: setMainMode,
    live,
    refusedCalls,
    reviewEndings,
    recordReview
  })
}

const defaultMode = (follows: SingleApprovalSource): string => {
  switch (follows.kind) {
    case "chat":
    case "space_thread":
      return DEFAULT_APPROVAL_MODE
    case "automation":
      return "ask"
  }
}

const chatPermission = (mode: typeof ApprovalModeSchema.Type) =>
  Effect.succeed({ kind: "chat" as const, approval_mode: mode })
