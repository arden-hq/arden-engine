import { Effect, Option, Schema } from "effect"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import {
  isApprovalMode,
  narrowerApprovalMode,
  type ApprovalMode
} from "@arden-hq/protocol/permissions"
import type { SqlClient, Statement } from "effect/unstable/sql"
import {
  RunCapabilitySchema,
  RunPolicySchema,
  narrowCapabilities,
  meetCapabilities,
  runApprovalMode,
  SessionResourceReachSchema,
  type SessionResourceReach,
  type RunCapability,
  type RunPolicy
} from "../../execution/policy.js"
import { RunAuthoritySchema } from "../../execution/authority.js"
import { TaskInferencePolicySchema } from "@arden-hq/protocol/effect/spaces"
import { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"
import {
  createExecutionBudget,
  readBudgetRemaining,
  readExecutionBudget
} from "./execution-budgets.js"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"
import { readCopySource } from "./automation-copy.js"
import { taskOpenSql } from "./task-status-sql.js"
import { defaultModeSql } from "./default-approval-mode.js"
import { ownerIsOn, ownerPolicy, readWorkOwner } from "./automation-rows.js"
import { isUserAutomationPurpose } from "../job-classification.js"

export const workerScopes = { code: "agent_code", research: "agent_research", work: "all" } as const

const failure = (message: string, cause?: unknown) =>
  new WorkStoreError({ reason: "conflict", message, ...(cause === undefined ? {} : { cause }) })

export const runPolicyRevoked = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment,
  workerOnly = true
) => sql`(
  (json_extract(${metadata}, '$.run_policy.authority_session_id') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sessions AS authority_session
      WHERE authority_session.session_id = json_extract(${metadata}, '$.run_policy.authority_session_id')
        AND authority_session.space_id IS json_extract(${metadata}, '$.run_policy.space.space_id')
        AND authority_session.archived_at IS NULL
        AND (json_extract(${metadata}, '$.run_policy.authority_generation') IS NULL
          OR COALESCE(json_extract(authority_session.metadata, '$.policy_generation'), 0)
            = json_extract(${metadata}, '$.run_policy.authority_generation'))))
  OR ((${workerOnly ? 1 : 0} = 0 OR json_extract(${metadata}, '$.run_policy.execution.mode') = 'worker')
    AND json_extract(${metadata}, '$.run_policy.space.space_id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM spaces AS policy_space
        WHERE policy_space.space_id = json_extract(${metadata}, '$.run_policy.space.space_id')
          AND policy_space.policy_generation = json_extract(${metadata}, '$.run_policy.space.generation')
          AND policy_space.archived_at IS NULL))
  OR EXISTS (SELECT 1 FROM json_each(COALESCE(
      json_extract(${metadata}, '$.run_policy.resource_sessions'), '[]')) AS resource
    LEFT JOIN sessions AS resource_session
      ON resource_session.session_id = json_extract(resource.value, '$.session_id')
    LEFT JOIN sessions AS resource_authority
      ON resource_authority.session_id = json_extract(resource.value, '$.authority_session_id')
    WHERE resource_session.session_id IS NULL OR resource_session.archived_at IS NOT NULL
      OR COALESCE(json_extract(resource_session.metadata, '$.policy_generation'), 0)
        != json_extract(resource.value, '$.generation')
      OR resource_authority.session_id IS NULL OR resource_authority.archived_at IS NOT NULL
      OR COALESCE(json_extract(resource_authority.metadata, '$.policy_generation'), 0)
        != json_extract(resource.value, '$.authority_generation'))
)`

const sessionResourceReach = Effect.fn("RunPolicy.sessionResourceReach")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<{ readonly metadata: string | null }>`
    SELECT metadata FROM sessions WHERE session_id = ${sessionId} AND archived_at IS NULL`
  const metadata = yield* decodeJson(
    Schema.Record(Schema.String, Schema.Unknown),
    rows[0]?.metadata ?? "{}"
  )
  const grant = Schema.decodeUnknownOption(
    Schema.Struct({
      version: Schema.Literal(1),
      source_session_id: Schema.NonEmptyString,
      source_policy_generation: Schema.Natural
    })
  )(metadata["fork_resources"])
  if (Option.isNone(grant)) return { sessions: [], sourcePolicy: undefined }

  const resources: SessionResourceReach[] = []
  let effectiveSourcePolicy: RunPolicy | undefined
  const seen = new Set([sessionId])
  let current = grant.value
  for (let depth = 0; depth < 64; depth += 1) {
    if (seen.has(current.source_session_id))
      return yield* failure("The fork resource chain is cyclic")
    seen.add(current.source_session_id)
    const sourceRows = yield* sql<{
      readonly metadata: string | null
      readonly session_type: string
      readonly origin_automation_id: string | null
      readonly generation: number
    }>`SELECT metadata, session_type, origin_automation_id,
        COALESCE(json_extract(metadata, '$.policy_generation'), 0) AS generation
      FROM sessions WHERE session_id = ${current.source_session_id} AND archived_at IS NULL`
    const source = sourceRows[0]
    if (source === undefined) return { sessions: [], sourcePolicy: undefined }
    const recent = yield* sql<{
      readonly policy: string | null
      readonly authority_json: string | null
      readonly revoked: number
    }>`
      SELECT json_extract(metadata_json, '$.run_policy') AS policy, authority_json,
        ${runPolicyRevoked(sql, sql`metadata_json`, false)} AS revoked FROM chat_runs
      WHERE session_id = ${current.source_session_id} AND authority_json IS NOT NULL
      ORDER BY started_at DESC, run_id DESC LIMIT 1`
    if (recent[0]?.revoked !== undefined && recent[0].revoked !== 0)
      return { sessions: [], sourcePolicy: undefined }
    let sourcePolicy: RunPolicy | undefined
    if (recent[0]?.policy != null)
      sourcePolicy = yield* decodeJson(RunPolicySchema, recent[0].policy)
    if (depth === 0) effectiveSourcePolicy = sourcePolicy
    if (recent[0] !== undefined && sourcePolicy === undefined)
      return yield* failure("The source chat's effective resource authority is unavailable")
    if (
      sourcePolicy === undefined &&
      (source.session_type !== "chat" || source.origin_automation_id !== null)
    )
      return { sessions: [], sourcePolicy: undefined }
    if (recent[0]?.authority_json != null) {
      const sourceAuthority = yield* decodeJson(RunAuthoritySchema, recent[0].authority_json)
      if (sourceAuthority.actor.kind !== "person") return { sessions: [], sourcePolicy: undefined }
    }
    const authoritySessionId = sourcePolicy?.authority_session_id ?? current.source_session_id
    const authorities = yield* sql<{ readonly generation: number }>`
      SELECT COALESCE(json_extract(metadata, '$.policy_generation'), 0) AS generation
      FROM sessions WHERE session_id = ${authoritySessionId} AND archived_at IS NULL`
    const authority = authorities[0]
    if (
      authority === undefined ||
      authority.generation !== current.source_policy_generation ||
      (recent[0] !== undefined && recent[0].revoked !== 0)
    )
      return { sessions: [], sourcePolicy: undefined }
    resources.push(
      yield* Schema.decodeUnknownEffect(SessionResourceReachSchema)({
        session_id: current.source_session_id,
        generation: source.generation,
        capabilities: sourcePolicy?.capabilities ?? ["all"],
        authority_session_id: authoritySessionId,
        authority_generation: authority.generation
      })
    )
    for (const inherited of sourcePolicy?.resource_sessions ?? []) {
      if (!resources.some((item) => item.session_id === inherited.session_id))
        resources.push(inherited)
    }
    const sourceMetadata = yield* decodeJson(
      Schema.Record(Schema.String, Schema.Unknown),
      source.metadata ?? "{}"
    )
    const parent = Schema.decodeUnknownOption(
      Schema.Struct({
        version: Schema.Literal(1),
        source_session_id: Schema.NonEmptyString,
        source_policy_generation: Schema.Natural
      })
    )(sourceMetadata["fork_resources"])
    if (sourcePolicy === undefined && Option.isSome(parent))
      return yield* failure("The source chat's inherited resource authority is unavailable")
    if (parent._tag === "None") return { sessions: resources, sourcePolicy: effectiveSourcePolicy }
    current = parent.value
  }
  return yield* failure("The fork resource chain is too deep")
})

export const captureRunPolicy = Effect.fn("RunPolicy.capture")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly runId: string
    readonly sessionId: string
    readonly spaceId: string | null
    readonly mode: "inline" | "worker"
    readonly approvalMode: ApprovalMode
    readonly automationId?: string
    readonly automationTokenLimit?: number
    readonly automationAttemptId?: number
    readonly automationCapabilities?: ReadonlyArray<RunCapability>
    readonly parentRunId?: string
    readonly previousRunId?: string | undefined
    readonly taskItemId?: string | undefined
    readonly sharesRunId?: string | undefined
    readonly workerScope?: "agent_code" | "agent_research" | "all"
  }
): Effect.fn.Return<RunPolicy, WorkStoreError> {
  return yield* Effect.gen(function* () {
    if (options.parentRunId !== undefined) {
      const rows = yield* sql<{ readonly policy: string | null; readonly revoked: number }>`
        SELECT json_extract(metadata_json, '$.run_policy') AS policy,
          ${runPolicyRevoked(sql, sql`metadata_json`, false)} AS revoked
        FROM chat_runs WHERE run_id = ${options.parentRunId}
      `
      const row = rows[0]
      if (!row?.policy) return yield* failure("Parent Run authority is no longer available")
      const parent = yield* decodeJson(RunPolicySchema, row.policy)
      if (parent.execution.observe)
        return yield* failure("Observation permission does not authorize delegated execution")
      if (parent.execution.mode === "inline") {
        const current = yield* captureRunPolicy(sql, {
          runId: options.runId,
          sessionId: options.sessionId,
          spaceId: options.spaceId,
          mode: "worker",
          approvalMode: runApprovalMode(parent),
          previousRunId: options.parentRunId,
          sharesRunId: options.parentRunId,
          ...(options.taskItemId === undefined ? {} : { taskItemId: options.taskItemId }),
          ...(options.workerScope === undefined ? {} : { workerScope: options.workerScope })
        })
        const scope = options.workerScope ?? "all"
        return {
          ...current,
          capabilities: narrowCapabilities(scope, current.capabilities)
        } satisfies RunPolicy
      }
      if (row.revoked) return yield* failure("Parent Run authority is no longer available")
      yield* readExecutionBudget(sql, options.parentRunId)
      const capability = options.workerScope ?? "all"
      return {
        ...parent,
        execution: { mode: "worker", observe: false },
        capabilities: narrowCapabilities(capability, parent.capabilities)
      } satisfies RunPolicy
    }
    let space: RunPolicy["space"] = null
    let googleAccounts: RunPolicy["google_accounts"] = null
    if (options.spaceId !== null) {
      const rows = yield* sql<{
        readonly space_id: string
        readonly policy_generation: number
        readonly inference_policy: string
      }>`SELECT space_id, policy_generation, inference_policy FROM spaces
        WHERE space_id = ${options.spaceId} AND archived_at IS NULL`
      const row = rows[0]
      if (!row) return yield* failure("The Space is archived or unavailable")
      space = {
        space_id: row.space_id,
        generation: row.policy_generation,
        inference: yield* decodeJson(TaskInferencePolicySchema, row.inference_policy)
      }
    }
    let capability: RunCapability = options.workerScope ?? "all"
    let approvalMode = options.approvalMode
    let observe = false
    let authoritySessionId = options.sessionId
    let budgetTask: BudgetTask = { kind: "home_chat", sessionId: options.sessionId }
    if (options.automationId !== undefined) {
      budgetTask = { kind: "none" }
      const owner = yield* readWorkOwner(sql, options.automationId)
      const around = yield* sql<{
        readonly default_mode: string
        readonly chat_mode: string | null
        readonly chat_id: string | null
        readonly claimed_by_hand: number
      }>`
        SELECT ${defaultModeSql(sql)} AS default_mode,
          json_extract(chat.metadata, '$.approval_mode') AS chat_mode, chat.session_id AS chat_id,
          EXISTS (SELECT 1 FROM automation_event_queue AS queue
            JOIN automation_runs AS attempt ON attempt.id = ${options.automationAttemptId ?? null}
            WHERE queue.task_id = ${options.automationId} AND attempt.task_id = queue.task_id
              AND queue.source = 'manual' AND queue.claimed_at IS NOT NULL AND attempt.status = 'running'
              AND json_extract(queue.context, '$.automation_run_id') = attempt.id) AS claimed_by_hand
        FROM (SELECT 1) AS one
        LEFT JOIN sessions AS run_chat ON run_chat.session_id = ${options.sessionId}
        LEFT JOIN sessions AS chat ON chat.session_id =
          COALESCE(
            json_extract(run_chat.metadata, '$.fork_origin.sourceSessionId'),
            json_extract(run_chat.metadata, '$.fork_of.source_session_id'),
            run_chat.session_id
          )`
      const facts = around[0]
      if (
        owner === undefined ||
        facts === undefined ||
        !(ownerIsOn(owner) || facts.claimed_by_hand === 1)
      )
        return yield* failure("The Automation is disabled or unavailable")
      const inSpaceMode = (ownRule: ApprovalMode): ApprovalMode =>
        isApprovalMode(facts.default_mode) ? facts.default_mode : ownRule
      if (owner.kind === "automation" && isUserAutomationPurpose(owner.purpose)) {
        if (facts.chat_id === null) return yield* failure("The execution Chat is unavailable")
        capability = "all"
        authoritySessionId = facts.chat_id
        approvalMode = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(
          facts.chat_mode ?? DEFAULT_APPROVAL_MODE
        )
      } else {
        const job = ownerPolicy(owner)
        capability = yield* Schema.decodeUnknownEffect(RunCapabilitySchema)(job.toolScope)
        if (job.approval.kind === "space") approvalMode = inSpaceMode("allow")
        else approvalMode = job.approval.autoApprove ? "allow" : "ask"
      }
      if (owner.kind === "space_review") observe = true
      if (owner.kind === "task") budgetTask = { kind: "task", itemId: owner.itemId }
    } else {
      const copy = yield* readCopySource(sql, options.sessionId)
      if (copy !== undefined) {
        authoritySessionId = copy.sessionId
        approvalMode = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(
          copy.approvalMode ?? DEFAULT_APPROVAL_MODE
        )
      }
    }
    let capabilities: RunPolicy["capabilities"] = [
      capability,
      ...(options.automationCapabilities ?? [])
    ]
    const resourceAdmission = yield* sessionResourceReach(sql, options.sessionId)
    let resourceSessions: ReadonlyArray<SessionResourceReach> = resourceAdmission.sessions
    const sourcePolicy = resourceAdmission.sourcePolicy
    if (sourcePolicy !== undefined) {
      capabilities = meetCapabilities(capabilities, sourcePolicy.capabilities)
      if (sourcePolicy.space === null && space !== null)
        return yield* failure("The source chat does not authorize this Space")
      if (sourcePolicy.space !== null) {
        if (space === null || space.space_id !== sourcePolicy.space.space_id)
          return yield* failure("The source chat's Space authority is unavailable in this Chat")
        space = {
          ...space,
          inference: { enabled: space.inference.enabled && sourcePolicy.space.inference.enabled }
        }
      }
      googleAccounts = intersectGoogleAccounts(googleAccounts, sourcePolicy.google_accounts)
    }
    const admittedRevision =
      options.automationAttemptId === undefined
        ? undefined
        : ((yield* sql<{ readonly instruction_revision_id: number | null }>`
              SELECT instruction_revision_id FROM automation_runs
              WHERE id = ${options.automationAttemptId}
                AND task_id = ${options.automationId ?? null}`)[0]?.instruction_revision_id ??
          undefined)
    let instructionRevisionId = admittedRevision
    if (options.previousRunId !== undefined) {
      const rows = yield* sql<{
        readonly policy: string | null
      }>`SELECT json_extract(metadata_json, '$.run_policy') AS policy
        FROM chat_runs WHERE run_id = ${options.previousRunId}`
      const previous = yield* decodeJson(RunPolicySchema, rows[0]?.policy ?? "null")
      const previousRevision = previous.automation_instruction_revision_id
      if (
        previousRevision !== undefined &&
        instructionRevisionId !== undefined &&
        previousRevision !== instructionRevisionId
      )
        return yield* failure("Continuation cannot change its Automation instructions")
      instructionRevisionId = previousRevision ?? instructionRevisionId
      authoritySessionId = previous.authority_session_id ?? authoritySessionId
      if (previous.space?.space_id !== space?.space_id)
        return yield* failure("Continuation cannot change its Space authority")
      capabilities = [
        ...capabilities,
        ...previous.capabilities.filter((inherited) => !capabilities.includes(inherited))
      ]
      approvalMode = narrowerApprovalMode(approvalMode, runApprovalMode(previous))
      googleAccounts = intersectGoogleAccounts(googleAccounts, previous.google_accounts)
      resourceSessions = intersectResourceSessions(
        resourceSessions,
        previous.resource_sessions ?? []
      )
    }
    const sharedOwner = resourceSessions[0]
    if (sharedOwner !== undefined) {
      const ownerRows = yield* sql<{ readonly approval_mode: string | null }>`
        SELECT json_extract(metadata, '$.approval_mode') AS approval_mode
        FROM sessions WHERE session_id = ${sharedOwner.authority_session_id} AND archived_at IS NULL`
      const sharedApproval = yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(
        ownerRows[0]?.approval_mode ?? DEFAULT_APPROVAL_MODE
      )
      approvalMode = narrowerApprovalMode(approvalMode, sharedApproval)
    }
    const shared =
      options.sharesRunId === undefined
        ? undefined
        : (yield* sql<{
            readonly budget_id: string | null
            readonly automation_id: string | null
            readonly instruction_revision_id: number | null
          }>`
          SELECT budget.budget_id, COALESCE(json_extract(run.metadata_json, '$.run_policy.automation_id'),
            json_extract(run.metadata_json, '$.automation.task_id')) AS automation_id,
            json_extract(run.metadata_json, '$.run_policy.automation_instruction_revision_id') AS instruction_revision_id
          FROM chat_runs AS run LEFT JOIN execution_budgets AS budget
            ON budget.budget_id = json_extract(run.metadata_json, '$.run_policy.budget_id')
          WHERE run.run_id = ${options.sharesRunId}`)[0]
    if (options.taskItemId !== undefined) budgetTask = { kind: "task", itemId: options.taskItemId }
    const budgetId = yield* runBudget(sql, {
      runId: options.runId,
      ...(options.automationTokenLimit === undefined
        ? {}
        : { automationTokenLimit: options.automationTokenLimit }),
      budgetTask,
      sharedBudgetId: shared?.budget_id
    })
    const authority = yield* sql<{ readonly generation: number }>`
      SELECT COALESCE(json_extract(metadata, '$.policy_generation'), 0) AS generation
      FROM sessions WHERE session_id = ${authoritySessionId} AND archived_at IS NULL`
    if (authority[0] === undefined) return yield* failure("The execution Chat is unavailable")
    const automationId = options.automationId ?? shared?.automation_id ?? undefined
    const sharedRevision = shared?.instruction_revision_id ?? undefined
    if (
      sharedRevision !== undefined &&
      instructionRevisionId !== undefined &&
      sharedRevision !== instructionRevisionId
    )
      return yield* failure("Shared Run cannot change its Automation instructions")
    const pinnedRevision = instructionRevisionId ?? sharedRevision
    return {
      authority_session_id: authoritySessionId,
      authority_generation: authority[0].generation,
      ...(automationId === undefined ? {} : { automation_id: automationId }),
      ...(pinnedRevision === undefined
        ? {}
        : { automation_instruction_revision_id: pinnedRevision }),
      budget_id: budgetId,
      execution: { mode: options.mode, observe },
      capabilities,
      // oxlint-disable-next-line arden/restricted-owner -- the stored legacy boolean of the mode, not a card outcome
      auto_approve: approvalMode === "allow",
      google_accounts: googleAccounts,
      resource_sessions: resourceSessions,
      space
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkStoreError ? cause : failure("Could not bind Run policy", cause)
    )
  )
})

type BudgetTask =
  | { readonly kind: "task"; readonly itemId: string }
  | { readonly kind: "home_chat"; readonly sessionId: string }
  | { readonly kind: "none" }

const runBudget = Effect.fn("RunPolicy.budget")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly runId: string
    readonly automationTokenLimit?: number
    readonly budgetTask: BudgetTask
    readonly sharedBudgetId: string | null | undefined
  }
) {
  const subject = options.budgetTask
  if (subject.kind !== "none") {
    const task = (yield* sql<{ readonly budget_id: string }>`
      SELECT budget.budget_id
      FROM space_tasks AS item JOIN execution_budgets AS budget ON budget.task_item_id = item.item_id
      WHERE ${taskOpenSql("item")} AND item.owner = 'worker'
        AND ${
          subject.kind === "task"
            ? sql`item.item_id = ${subject.itemId}`
            : sql`item.home_session_id = ${subject.sessionId} AND item.runs_in = 'chat'
                AND item.blocked = 0`
        }
      LIMIT 1`)[0]
    if (task !== undefined) return task.budget_id
  }
  if (options.sharedBudgetId != null) {
    yield* readBudgetRemaining(sql, options.sharedBudgetId)
    return options.sharedBudgetId
  }
  const budgetId = yield* createExecutionBudget(sql, options.runId)
  if (options.automationTokenLimit !== undefined)
    yield* sql`UPDATE execution_budgets SET token_limit = ${options.automationTokenLimit}
      WHERE budget_id = ${budgetId}`
  return budgetId
})

const intersectGoogleAccounts = (
  left: RunPolicy["google_accounts"],
  right: RunPolicy["google_accounts"]
): RunPolicy["google_accounts"] => {
  if (left === null) return right
  if (right === null) return left
  return left.filter((grant) =>
    right.some(
      (allowed) => allowed.account_id === grant.account_id && allowed.service === grant.service
    )
  )
}

const intersectResourceSessions = (
  current: ReadonlyArray<SessionResourceReach>,
  previous: ReadonlyArray<SessionResourceReach>
): ReadonlyArray<SessionResourceReach> =>
  current.flatMap((resource) => {
    const held = previous.find(
      (candidate) =>
        candidate.session_id === resource.session_id &&
        candidate.generation === resource.generation &&
        candidate.authority_session_id === resource.authority_session_id &&
        candidate.authority_generation === resource.authority_generation
    )
    return held === undefined
      ? []
      : [
          {
            ...resource,
            capabilities: meetCapabilities(resource.capabilities, held.capabilities)
          }
        ]
  })
