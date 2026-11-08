import { DateTime, Effect, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  confirmedToolOutcomeResult,
  rejectedToolResult,
  ToolExecutionStore,
  ToolExecutionStoreError,
  type ApprovalAlternativeInput,
  type ApprovalEditsInput,
  type ResolveToolApprovalInput,
  type ResolveToolApprovalResult
} from "../tools/store.js"
import { spaceFolderGrantOf } from "../permissions/space-folder-approval.js"
import { ardenStateRoot, resolveLocalDirectory } from "../../storage/local-paths.js"
import { decodeJson, encodeJson } from "./json.js"
import {
  cardRuleList,
  cardRuleSubjects,
  connectorUpdatedAt,
  grantCardRulesInTransaction,
  runRuleList,
  savedIn
} from "./permissions.js"
import { parseMcpSource } from "../../mcp/naming.js"
import type { RuleList } from "../permissions/rules.js"
import type { RuleSavedIn } from "@arden-hq/protocol/runs"
import type { StandingRuleList } from "@arden-hq/protocol/chat"
import type { PermissionStoreError } from "../permissions/store.js"
import type { PersistenceDeps } from "./deps.js"
import {
  type ToolCallRow,
  type ChatRunRow,
  type UpdatedToolRow,
  PersistedToolResultSchema,
  toolError,
  preserveToolError,
  decodeResult,
  decodePendingConnection,
  loadApprovalRow
} from "./tool-rows.js"
import {
  attachFolderToSpaceInTransaction,
  type ApprovalFolderResolutions
} from "./tool-approval-folders.js"
import { isTerminalRunStatus } from "@arden-hq/protocol/runs"
import { announceRunAskChange } from "./ask-changes.js"
import { noApprovalForRun } from "./approval-policy.js"
import { detachedWorkflowCalls, requireLiveWorkflowOwner } from "./detached-workflow-calls.js"

const ResolveToolApprovalInputSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  toolCallId: Schema.NonEmptyString,
  approved: Schema.optionalKey(Schema.Boolean),
  feedback: Schema.optionalKey(Schema.String),
  grantStanding: Schema.optionalKey(Schema.Boolean),
  grantList: Schema.optionalKey(Schema.Literals(["space", "global"])),
  attachFolderToSpace: Schema.optionalKey(Schema.Boolean)
})

const decodeResolveInput = Effect.fn("SqliteToolExecutionStore.decodeResolveInput")(function* (
  input: ResolveToolApprovalInput
): Effect.fn.Return<
  Required<Pick<ResolveToolApprovalInput, "runId" | "toolCallId" | "approved">> & {
    readonly feedback: string | null
    readonly grantStanding: boolean
    readonly grantList: StandingRuleList | undefined
    readonly attachFolderToSpace: boolean
    readonly edits: ApprovalEditsInput | null
    readonly alternative: ApprovalAlternativeInput | null
  },
  ToolExecutionStoreError
> {
  const { edits, alternative, ...fields } = input
  const decoded = yield* Schema.decodeUnknownEffect(ResolveToolApprovalInputSchema)(fields, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      toolError("resolve", "invalid", "Invalid tool approval decision", input, cause)
    )
  )
  if (decoded.approved === undefined) {
    return yield* toolError("resolve", "invalid", "Tool approval decision is required", decoded)
  }
  if (decoded.grantStanding === true && decoded.approved !== true) {
    return yield* toolError(
      "resolve",
      "invalid",
      "A standing permission requires approval",
      decoded
    )
  }
  if (decoded.grantList !== undefined && decoded.grantStanding !== true) {
    return yield* toolError(
      "resolve",
      "invalid",
      "Where to save names a standing permission",
      decoded
    )
  }
  if (decoded.attachFolderToSpace === true && decoded.approved !== true) {
    return yield* toolError(
      "resolve",
      "invalid",
      "Attaching a Local folder requires approval",
      decoded
    )
  }
  if (decoded.attachFolderToSpace === true && decoded.grantStanding === true) {
    return yield* toolError(
      "resolve",
      "invalid",
      "One approval cannot create two persistent grants",
      decoded
    )
  }
  if (edits !== undefined && decoded.approved !== true) {
    return yield* toolError("resolve", "invalid", "Edits on the card require approval", decoded)
  }
  if (
    alternative !== undefined &&
    (decoded.approved !== true ||
      decoded.grantStanding === true ||
      decoded.attachFolderToSpace === true)
  ) {
    return yield* toolError(
      "resolve",
      "invalid",
      "Save as draft is its own answer: it approves the draft and grants nothing",
      decoded
    )
  }
  const feedback = decoded.feedback?.trim() || null
  return {
    runId: decoded.runId,
    toolCallId: decoded.toolCallId,
    approved: decoded.approved,
    feedback,
    grantStanding: decoded.grantStanding === true,
    grantList: decoded.grantList,
    attachFolderToSpace: decoded.attachFolderToSpace === true,
    edits: edits ?? null,
    alternative: alternative ?? null
  }
})

const resolveApprovalFolders = Effect.fn("SqliteToolExecutionStore.resolveApprovalFolders")(
  function* (
    sql: SqlClient.SqlClient,
    stateRoot: string | null,
    decision: {
      readonly runId: string
      readonly toolCallId: string
      readonly grantStanding: boolean
      readonly attachFolderToSpace: boolean
    }
  ): Effect.fn.Return<ApprovalFolderResolutions, ToolExecutionStoreError> {
    if (!decision.grantStanding && !decision.attachFolderToSpace) return new Map()
    const approval = yield* loadApprovalRow(sql, decision.runId, decision.toolCallId, "resolve")
    if (approval === null) return new Map()
    const payload = yield* decodeJson(JsonObjectSchema, approval.payload_json).pipe(Effect.option)
    if (payload._tag === "None") return new Map()
    const data = payload.value["approval_data"]
    const folders = [spaceFolderGrantOf(approval.tool_name, data)?.local_folder].filter(
      (folder) => folder !== undefined
    )
    const resolved = yield* Effect.forEach(folders, (folder) =>
      Effect.tryPromise({
        try: () => resolveLocalDirectory(folder, null, stateRoot),
        catch: (cause) => cause
      }).pipe(
        Effect.result,
        Effect.map((result) => [folder, result] as const)
      )
    )
    return new Map(resolved)
  }
)

export const makeToolApprovalResolve = ({
  writer,
  sessionEvents,
  dataDir
}: Pick<PersistenceDeps, "writer" | "sessionEvents"> & {
  readonly dataDir: string | null
}): ToolExecutionStore["Service"]["resolve"] => {
  const resolveInTransaction = makeToolApprovalResolveInTransaction({
    sql: writer.sql,
    sessionEvents
  })
  return Effect.fn("SqliteToolExecutionStore.resolve")(function* (input: ResolveToolApprovalInput) {
    const decision = yield* decodeResolveInput(input)
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    const approvedFolders = yield* resolveApprovalFolders(
      writer.sql,
      dataDir === null ? null : ardenStateRoot(dataDir),
      decision
    )
    return yield* writer
      .transact(resolveInTransaction({ decision, timestamp, approvedFolders }))
      .pipe(Effect.mapError(preserveToolError("resolve", decision)))
  })
}

export const makeToolApprovalResolveInTransaction = ({
  sql,
  sessionEvents
}: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: PersistenceDeps["sessionEvents"]
}) =>
  Effect.fn("SqliteToolExecutionStore.resolveInTransaction")(function* ({
    decision,
    timestamp,
    approvedFolders
  }: {
    readonly decision: Effect.Success<ReturnType<typeof decodeResolveInput>>
    readonly timestamp: string
    readonly approvedFolders: ApprovalFolderResolutions
  }) {
    const approval = yield* loadApprovalRow(sql, decision.runId, decision.toolCallId, "resolve")
    if (approval === null) {
      return yield* toolError(
        "resolve",
        "not_found",
        "Pending tool approval was not found",
        decision
      )
    }
    if (approval.status !== "pending") {
      const previous =
        approval.resolution_json === null
          ? null
          : yield* decodeJson(JsonObjectSchema, approval.resolution_json).pipe(
              Effect.mapError((cause) =>
                toolError(
                  "resolve",
                  "corrupt",
                  "Stored tool approval resolution is corrupt",
                  decision,
                  cause
                )
              )
            )
      if (
        previous?.approved !== decision.approved ||
        (previous.feedback ?? null) !== decision.feedback ||
        (previous.grant_standing === true) !== decision.grantStanding ||
        (previous.grant_list ?? undefined) !== decision.grantList ||
        (previous.attach_folder_to_space === true) !== decision.attachFolderToSpace ||
        (previous.edited_arguments !== undefined) !== (decision.edits !== null) ||
        (previous.alternative ?? null) !== (decision.alternative?.kind ?? null)
      ) {
        return yield* toolError(
          "resolve",
          "conflict",
          "Tool approval was resolved differently",
          decision
        )
      }
      const ready = yield* sql<{ readonly count: number }>`
  SELECT COUNT(*) AS count FROM tool_approvals
  WHERE run_id = ${decision.runId} AND status = 'pending'
`
      const resumable = yield* sql<{ readonly count: number }>`
  SELECT COUNT(*) AS count FROM chat_runs AS run
  JOIN tool_calls AS tool ON tool.run_id = run.run_id
  WHERE run.run_id = ${decision.runId} AND run.status = 'pending'
    AND tool.tool_call_id = ${decision.toolCallId} AND tool.status = 'ready'
`
      return {
        runId: decision.runId,
        ready: ready[0]?.count === 0 && resumable[0]?.count === 1
      } satisfies ResolveToolApprovalResult
    }
    if (approval.kind !== "tool_approval" && approval.kind !== "tool_outcome") {
      return yield* toolError(
        "resolve",
        "corrupt",
        "Stored tool approval kind is invalid",
        decision
      )
    }
    if (approval.kind === "tool_approval") yield* requireLiveWorkflowOwner(sql, decision, "resolve")
    if (
      approval.kind === "tool_approval" &&
      decision.approved &&
      (yield* noApprovalForRun(sql, decision.runId))
    ) {
      return yield* toolError(
        "resolve",
        "conflict",
        "Side chats cannot approve pending tool calls; reject this card or close the Side chat",
        decision
      )
    }
    const runs = yield* sql<ChatRunRow>`
SELECT status FROM chat_runs
WHERE run_id = ${decision.runId} AND session_id = ${approval.session_id}
LIMIT 1
        `.pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "storage", "Could not read the owning chat run", decision, cause)
      )
    )
    const runStatus = runs[0]?.status
    const terminalOutcome =
      approval.kind === "tool_outcome" && runStatus !== undefined && isTerminalRunStatus(runStatus)
    const detached = yield* detachedWorkflowCalls(sql, decision.runId, [decision.toolCallId]).pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "storage", "Could not read the detached script owner", decision, cause)
      )
    )
    if (runStatus !== "pending" && !terminalOutcome && !detached.has(decision.toolCallId)) {
      return yield* toolError(
        "resolve",
        "conflict",
        "Owning chat run is not waiting for a decision",
        decision
      )
    }
    const toolRows = yield* sql<ToolCallRow>`
SELECT session_id, tool_name, arguments_json, changes_state, status, result_json
FROM tool_calls
WHERE run_id = ${decision.runId} AND tool_call_id = ${decision.toolCallId}
LIMIT 1
        `.pipe(
      Effect.mapError((cause) =>
        toolError(
          "resolve",
          "storage",
          "Could not read the pending tool execution",
          decision,
          cause
        )
      )
    )
    const tool = toolRows[0]
    if (tool === undefined) {
      return yield* toolError(
        "resolve",
        "not_found",
        "Pending tool execution was not found",
        decision
      )
    }
    if (tool.session_id !== approval.session_id || tool.tool_name !== approval.tool_name) {
      return yield* toolError(
        "resolve",
        "corrupt",
        "Tool approval does not match its execution",
        decision
      )
    }
    const storedApproval = yield* decodeJson(JsonObjectSchema, approval.payload_json).pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "corrupt", "Stored tool approval payload is corrupt", decision, cause)
      )
    )
    const editedArguments = yield* approvedEdits(tool, approval, decision)
    if (
      decision.alternative !== null &&
      (approval.kind !== "tool_approval" || !decision.alternative.offeredBy(approval.tool_name))
    ) {
      return yield* toolError(
        "resolve",
        "invalid",
        "This call cannot be saved as a draft",
        decision
      )
    }
    yield* decodePendingConnection(approval, "resolve")
    let saved: RuleSavedIn | null = null
    let standingSkipped = false
    if (decision.grantStanding) {
      if (approval.kind !== "tool_approval") {
        return yield* toolError(
          "resolve",
          "invalid",
          "Outcome verification cannot create a standing permission",
          decision
        )
      }
      if (approval.tool_name === "browser_permission") {
      } else {
        saved = yield* saveCardRule(sql, { approval, payload: storedApproval, decision })
        standingSkipped = saved === null
      }
    }

    let resultJson: string | null = null
    let nextToolStatus: "ready" | "completed"
    if (approval.kind === "tool_approval" && decision.approved) {
      if (tool.status !== "paused" || tool.result_json !== null) {
        return yield* toolError(
          "resolve",
          "conflict",
          "Tool execution is not awaiting approval",
          decision
        )
      }
      nextToolStatus = "ready"
    } else {
      const expectedStatus = approval.kind === "tool_approval" ? "paused" : "uncertain"
      if (tool.status !== expectedStatus) {
        return yield* toolError(
          "resolve",
          "conflict",
          "Tool execution does not match its pending decision",
          decision
        )
      }
      const synthetic =
        approval.kind === "tool_approval"
          ? rejectedToolResult(decision, decision.feedback)
          : confirmedToolOutcomeResult(decision, decision.approved, decision.feedback)
      const result = yield* decodeResult(synthetic, "resolve", decision)
      resultJson = yield* encodeJson(PersistedToolResultSchema, result).pipe(
        Effect.mapError((cause) =>
          toolError("resolve", "corrupt", "Resolved tool result is invalid", decision, cause)
        )
      )
      nextToolStatus = "completed"
    }

    if (decision.attachFolderToSpace) {
      yield* attachFolderToSpaceInTransaction(
        sql,
        approval,
        storedApproval,
        approvedFolders,
        decision
      )
    }

    const toolUpdated =
      nextToolStatus === "ready"
        ? yield* sql<UpdatedToolRow>`
    UPDATE tool_calls
    SET status = 'ready', result_json = NULL, ended_at = NULL
    WHERE run_id = ${decision.runId} AND tool_call_id = ${decision.toolCallId}
      AND status = 'paused'
    RETURNING status
  `
        : yield* sql<UpdatedToolRow>`
    UPDATE tool_calls
    SET status = 'completed', result_json = ${resultJson}, ended_at = ${timestamp}
    WHERE run_id = ${decision.runId} AND tool_call_id = ${decision.toolCallId}
      AND status = ${approval.kind === "tool_approval" ? "paused" : "uncertain"}
    RETURNING status
  `
    if (toolUpdated.length !== 1) {
      return yield* toolError(
        "resolve",
        "conflict",
        "Tool execution changed before resolution",
        decision
      )
    }

    const resolutionJson = yield* encodeJson(JsonObjectSchema, {
      approved: decision.approved,
      feedback: decision.feedback,
      ...(decision.grantStanding ? { grant_standing: true } : {}),
      ...(decision.grantList === undefined ? {} : { grant_list: decision.grantList }),
      ...(saved === null ? {} : { saved_in: saved }),
      ...(standingSkipped ? { standing_skipped: true } : {}),
      ...(decision.attachFolderToSpace ? { attach_folder_to_space: true } : {}),
      ...(editedArguments === null ? {} : { edited_arguments: editedArguments }),
      ...(decision.alternative === null ? {} : { alternative: decision.alternative.kind })
    }).pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "corrupt", "Tool approval resolution is invalid", decision, cause)
      )
    )
    const approvalUpdated = yield* sql<UpdatedToolRow>`
UPDATE tool_approvals
SET status = ${decision.approved ? "approved" : "rejected"},
    resolved_at = ${timestamp},
    result_feedback = ${decision.feedback},
    resolution_json = ${resolutionJson}
WHERE run_id = ${decision.runId} AND tool_call_id = ${decision.toolCallId}
  AND status = 'pending'
RETURNING status
        `.pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "storage", "Could not resolve tool approval", decision, cause)
      )
    )
    if (approvalUpdated.length !== 1) {
      return yield* toolError(
        "resolve",
        "conflict",
        "Tool approval changed before resolution",
        decision
      )
    }
    yield* sql`
UPDATE chat_runs
SET updated_at = ${timestamp}
WHERE run_id = ${decision.runId} AND status = 'pending'
        `.pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "storage", "Could not update the waiting chat run", decision, cause)
      )
    )
    const siblings = yield* sql<{ readonly count: number }>`
SELECT COUNT(*) AS count
FROM tool_approvals
WHERE run_id = ${decision.runId} AND status = 'pending'
        `.pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "storage", "Could not check remaining tool approvals", decision, cause)
      )
    )
    yield* sql`
UPDATE sessions
SET last_activity = ${timestamp}
WHERE session_id = ${approval.session_id}
        `
    yield* sessionEvents.appendInTransaction("session_activity", approval.session_id)
    yield* announceRunAskChange(sql, sessionEvents, decision.runId)
    return {
      runId: decision.runId,
      ready: (siblings[0]?.count ?? 0) === 0
    } satisfies ResolveToolApprovalResult
  })

const approvedEdits = Effect.fn("SqliteToolExecutionStore.approvedEdits")(function* (
  tool: ToolCallRow,
  approval: { readonly kind: string; readonly tool_name: string },
  decision: {
    readonly runId: string
    readonly toolCallId: string
    readonly edits: ApprovalEditsInput | null
  }
): Effect.fn.Return<JsonObject | null, ToolExecutionStoreError> {
  const edits = decision.edits
  if (edits === null) return null
  const identity = { runId: decision.runId, toolCallId: decision.toolCallId }
  if (approval.kind !== "tool_approval") {
    return yield* toolError("resolve", "invalid", "Only a tool approval takes edits", identity)
  }
  const requested = yield* decodeJson(JsonObjectSchema, tool.arguments_json).pipe(
    Effect.mapError((cause) =>
      toolError("resolve", "corrupt", "Stored tool arguments are corrupt", identity, cause)
    )
  )
  const outcome = edits.apply({ toolName: approval.tool_name, requested, patch: edits.patch })
  switch (outcome._tag) {
    case "Edited":
      return outcome.arguments
    case "Unchanged":
      return null
    case "Refused":
      return yield* toolError("resolve", "invalid", outcome.reason, identity)
  }
})

type Decision = Pick<ResolveToolApprovalInput, "runId" | "toolCallId">

const resolveError =
  (decision: Decision) =>
  (cause: { readonly reason: string; readonly message: string }): ToolExecutionStoreError =>
    toolError(
      "resolve",
      cause.reason === "invalid" ? "invalid" : "storage",
      cause.message,
      decision,
      cause
    )

const cardListNow = Effect.fn("SqliteToolExecutionStore.cardListNow")(function* (
  sql: SqlClient.SqlClient,
  approval: { readonly run_id: string },
  asked: unknown,
  decision: Decision & { readonly grantList: StandingRuleList | undefined }
): Effect.fn.Return<RuleList, ToolExecutionStoreError> {
  const now = yield* runRuleList(sql, approval.run_id).pipe(Effect.mapError(resolveError(decision)))
  const list = cardRuleList({ asked, now, picked: decision.grantList })
  if (list === undefined)
    return yield* toolError(
      "resolve",
      "conflict",
      "The permission holder or MCP connection changed after approval was requested",
      decision
    )
  return list
})

const savedInFor = (sql: SqlClient.SqlClient, list: RuleList, decision: Decision) =>
  savedIn(sql, list).pipe(
    Effect.mapError((cause: PermissionStoreError) => resolveError(decision)(cause))
  )

export const saveCardRule = Effect.fn("SqliteToolExecutionStore.saveCardRule")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly approval: {
      readonly run_id: string
      readonly tool_call_id: string
      readonly tool_name: string
    }
    readonly payload: JsonObject
    readonly decision: Decision & { readonly grantList: StandingRuleList | undefined }
  }
): Effect.fn.Return<RuleSavedIn | null, ToolExecutionStoreError> {
  const { approval, payload, decision } = input
  if (payload.grant_principal === undefined) return null
  const source = payload.tool_source
  const serverName = Predicate.isString(source) ? parseMcpSource(source)?.serverName : undefined
  const subjects = cardRuleSubjects({
    toolName: approval.tool_name,
    serverName,
    data: payload.approval_data
  })
  if (subjects === undefined)
    return yield* toolError(
      "resolve",
      "blocked",
      "This approval cannot create a standing permission",
      decision
    )
  const list = yield* cardListNow(sql, approval, payload.grant_principal, decision)
  if (serverName !== undefined) {
    const updatedAt = yield* connectorUpdatedAt(sql, serverName).pipe(
      Effect.mapError(resolveError(decision))
    )
    if (updatedAt === undefined || updatedAt !== payload.mcp_updated_at)
      return yield* toolError(
        "resolve",
        "conflict",
        "The permission holder or MCP connection changed after approval was requested",
        decision
      )
  }
  const wrote = yield* grantCardRulesInTransaction(sql, {
    subjects,
    list,
    source: { kind: "card", runId: approval.run_id, toolCallId: approval.tool_call_id }
  }).pipe(Effect.mapError(resolveError(decision)))
  return wrote ? yield* savedInFor(sql, list, decision) : null
})
