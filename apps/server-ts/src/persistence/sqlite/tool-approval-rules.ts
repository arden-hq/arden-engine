import { Effect, Predicate } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  APPROVAL_EDIT_OUTCOME,
  TOOL_STORE_FAILURE,
  ToolExecutionStoreError,
  type ApprovalEditsInput,
  type ResolveToolApprovalInput
} from "../tools/store.js"
import { decodeJson } from "./json.js"
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
import { TOOL_APPROVAL_KIND, type ToolCallRow, toolError } from "./tool-rows.js"
import { GRANT_LIST } from "@arden-hq/protocol/chat"
import { PERMISSION_RULE_SUBJECT } from "@arden-hq/protocol/permissions"

export const approvedEdits = Effect.fn("SqliteToolExecutionStore.approvedEdits")(function* (
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
  if (approval.kind !== TOOL_APPROVAL_KIND.approval) {
    return yield* toolError("resolve", "invalid", "Only a tool approval takes edits", identity)
  }
  const requested = yield* decodeJson(JsonObjectSchema, tool.arguments_json).pipe(
    Effect.mapError((cause) =>
      toolError("resolve", "corrupt", "Stored tool arguments are corrupt", identity, cause)
    )
  )
  const outcome = edits.apply({ toolName: approval.tool_name, requested, patch: edits.patch })
  switch (outcome._tag) {
    case APPROVAL_EDIT_OUTCOME.Edited:
      return outcome.arguments
    case APPROVAL_EDIT_OUTCOME.Unchanged:
      return null
    case APPROVAL_EDIT_OUTCOME.Refused:
      return yield* toolError("resolve", "invalid", outcome.reason, identity)
  }
})

export type Decision = Pick<ResolveToolApprovalInput, "runId" | "toolCallId">

const resolveError =
  (decision: Decision) =>
  (cause: { readonly reason: string; readonly message: string }): ToolExecutionStoreError =>
    toolError(
      "resolve",
      cause.reason === TOOL_STORE_FAILURE.invalid
        ? TOOL_STORE_FAILURE.invalid
        : TOOL_STORE_FAILURE.storage,
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
  if (
    decision.grantList === GRANT_LIST.global &&
    subjects.every((subject) => subject.kind === PERMISSION_RULE_SUBJECT.vaultKey)
  )
    return yield* toolError(
      "resolve",
      "blocked",
      "A key's Always allow holds in this Space only",
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
