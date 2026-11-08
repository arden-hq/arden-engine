import { Effect, Option, Schema } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"

import {
  COMMAND_TOOL,
  CommandGrantApprovalDataSchema,
  WordsGrantApprovalDataSchema
} from "../permissions/command-policy.js"
import { mcpSource, parseMcpSource } from "../../mcp/naming.js"
import {
  PermissionStore,
  PermissionStoreError,
  type PermissionStoreOperation
} from "../permissions/store.js"
import {
  wordsRuleText,
  type RuleList,
  type RuleSource,
  type RuleSubject
} from "../permissions/rules.js"
import { RuleSavedInSchema, type RuleSavedIn } from "@arden-hq/protocol/effect/runs"
import type { StandingRuleList } from "@arden-hq/protocol/chat"
import { runAuthorityState, type RunAuthorityState } from "./run-context.js"
import { storedAuthority } from "./run-authority.js"
import { ownRuleList } from "../../execution/rules.js"
import { allowsSave, saveAllowsInTransaction } from "./permission-rules.js"
import type { PersistenceDeps } from "./deps.js"
import {
  allowSubjects,
  changeJson,
  commandSubjects,
  type OfferHistory,
  type OfferHolders,
  type PermissionChange
} from "../permissions/offer.js"

type StandingPrincipal = `space:${string}` | "global" | "system"

const principalOf = (list: RuleList): StandingPrincipal =>
  list.kind === "space" ? `space:${list.spaceId}` : list.kind

export interface ApprovalPermissionContext {
  readonly principal: StandingPrincipal
  readonly places: ReadonlyArray<RuleSavedIn>
  readonly mcp: {
    readonly serverName: string
    readonly source: string
    readonly serverUpdatedAt: string
  } | null
}

const LEGACY_COMMAND_PRINCIPAL = "command:global"

export const cardRuleList = (input: {
  readonly asked: unknown
  readonly now: RuleList | undefined
  readonly picked: StandingRuleList | undefined
}): RuleList | undefined => {
  const { now, picked } = input
  if (now === undefined) return undefined
  if (input.asked === LEGACY_COMMAND_PRINCIPAL)
    return picked === "space" ? undefined : { kind: "global" }
  if (input.asked !== principalOf(now)) return undefined
  switch (now.kind) {
    case "space":
      return picked === "global" ? { kind: "global" } : now
    case "global":
      return picked === "space" ? undefined : now
    case "system":
      if (picked === "global") return { kind: "global" }
      return picked === undefined ? now : undefined
  }
}

export const ruleSavedInSql = (
  sql: SqlClient.SqlClient,
  list: { readonly kind: Statement.Fragment; readonly spaceId: Statement.Fragment }
): Statement.Fragment => sql`(CASE ${list.kind}
  WHEN 'space' THEN json_object('kind', 'space', 'name',
    COALESCE((SELECT name FROM spaces WHERE space_id = ${list.spaceId}), ''))
  WHEN 'system' THEN json_object('kind', 'system')
  ELSE json_object('kind', 'everywhere') END)`

const SavedInJsonSchema = Schema.fromJsonString(RuleSavedInSchema)

export const savedIn = Effect.fn("SqlitePermissionStore.savedIn")(function* (
  sql: SqlClient.SqlClient,
  list: RuleList
): Effect.fn.Return<RuleSavedIn, PermissionStoreError> {
  const spaceId = list.kind === "space" ? list.spaceId : null
  const rows = yield* sql<{ readonly saved_in: string }>`
    SELECT ${ruleSavedInSql(sql, { kind: sql`${list.kind}`, spaceId: sql`${spaceId}` })} AS saved_in
  `.pipe(Effect.mapError(storage("run_grants", "Could not read the Space's name")))
  return yield* Schema.decodeUnknownEffect(SavedInJsonSchema)(rows[0]?.saved_in).pipe(
    Effect.mapError(storage("run_grants", "Could not read where the rule went"))
  )
})

const error = (
  operation: PermissionStoreOperation,
  reason: PermissionStoreError["reason"],
  message: string,
  cause?: unknown
) =>
  new PermissionStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const storage = (operation: PermissionStoreOperation, message: string) => (cause: unknown) =>
  cause instanceof PermissionStoreError ? cause : error(operation, "storage", message, cause)

interface RunRuleHome {
  readonly list: RuleList
  readonly spaceName: string
}

const runRuleHome = Effect.fn("SqlitePermissionStore.runRuleHome")(function* (
  sql: SqlClient.SqlClient,
  runId: string
): Effect.fn.Return<RunRuleHome | undefined, PermissionStoreError> {
  const rows = yield* sql<{
    readonly authority_json: string | null
    readonly authority: RunAuthorityState
    readonly space_name: string | null
  }>`
    SELECT run.authority_json, space.name AS space_name,
      ${runAuthorityState(sql, sql`run.metadata_json`, sql`run.run_id`)} AS authority
    FROM chat_runs AS run
    LEFT JOIN spaces AS space ON space.space_id = json_extract(run.authority_json, '$.owns.space_id')
    WHERE run.run_id = ${runId}
  `.pipe(Effect.mapError(storage("run_grants", "Could not read the run's Space")))
  const row = rows[0]
  if (row === undefined || row.authority !== "active") return undefined
  const authority = storedAuthority(row.authority_json)
  if (authority === undefined) return undefined
  return { list: ownRuleList(authority) ?? { kind: "global" }, spaceName: row.space_name ?? "" }
})

export const runRuleList = (sql: SqlClient.SqlClient, runId: string) =>
  runRuleHome(sql, runId).pipe(Effect.map((home) => home?.list))

export const connectorUpdatedAt = Effect.fn("SqlitePermissionStore.connectorUpdatedAt")(function* (
  sql: SqlClient.SqlClient,
  serverName: string
) {
  const rows = yield* sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM mcp_servers WHERE name = ${serverName} LIMIT 1
    `.pipe(Effect.mapError(storage("run_grants", "Could not validate the MCP permission source")))
  return rows[0]?.updated_at
})

export const cardRuleSubjects = (input: {
  readonly toolName: string
  readonly serverName: string | undefined
  readonly data: unknown
}): ReadonlyArray<RuleSubject> | undefined => {
  if (input.serverName !== undefined)
    return [{ kind: "tool", tool: input.toolName, server: input.serverName }]
  if (input.toolName !== COMMAND_TOOL) return undefined
  const words = Schema.decodeUnknownOption(WordsGrantApprovalDataSchema)(input.data)
  if (Option.isSome(words))
    return [{ kind: "words", text: wordsRuleText(words.value.words_grant.text) }]
  const data = Schema.decodeUnknownOption(CommandGrantApprovalDataSchema)(input.data)
  return Option.isSome(data) ? commandSubjects(data.value.command_grant.rules) : undefined
}

export const approvalPermissionContext = Effect.fn(
  "SqlitePermissionStore.approvalPermissionContext"
)(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string
    readonly toolName: string
    readonly source: string | undefined
    readonly data: unknown
  }
): Effect.fn.Return<ApprovalPermissionContext | null, PermissionStoreError> {
  const serverName = parseMcpSource(input.source)?.serverName
  const subjects = cardRuleSubjects({ toolName: input.toolName, serverName, data: input.data })
  if (subjects === undefined) return null
  const home = yield* runRuleHome(sql, input.runId)
  if (home === undefined) return null
  const updatedAt = serverName === undefined ? null : yield* connectorUpdatedAt(sql, serverName)
  if (updatedAt === undefined) return null
  const lists: ReadonlyArray<RuleList> =
    home.list.kind === "global" ? [home.list] : [home.list, { kind: "global" }]
  const places: RuleSavedIn[] = []
  for (const list of lists) {
    const saves = yield* allowsSave(sql, { subjects, list }).pipe(
      Effect.mapError(storage("run_grants", "Could not read the rules"))
    )
    if (saves) places.push(yield* savedIn(sql, list))
  }
  if (places.length === 0) return null
  return {
    principal: principalOf(home.list),
    places,
    mcp:
      serverName === undefined || updatedAt === null
        ? null
        : { serverName, source: mcpSource(serverName), serverUpdatedAt: updatedAt }
  }
})

export const grantCardRulesInTransaction = (
  sql: SqlClient.SqlClient,
  input: {
    readonly subjects: ReadonlyArray<RuleSubject>
    readonly list: RuleList
    readonly source: RuleSource
  }
) =>
  saveAllowsInTransaction(sql, input).pipe(
    Effect.mapError(storage("run_grants", "Could not store the permission rule"))
  )

export const makePermissionStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): PermissionStore["Service"] => {
  const sql = writer.sql
  const offerHolders = Effect.fn("SqlitePermissionStore.offerHolders")(function* (
    runId: string
  ): Effect.fn.Return<OfferHolders | null, PermissionStoreError> {
    const home = yield* runRuleHome(sql, runId)
    if (home === undefined) return null
    return {
      shared:
        home.list.kind === "space"
          ? { kind: "space", principal: principalOf(home.list), name: home.spaceName }
          : null
    }
  })

  const allowSaves = Effect.fn("SqlitePermissionStore.allowSaves")(
    function* (change: PermissionChange, serverName: string | null, list: RuleList) {
      return yield* allowsSave(sql, { subjects: allowSubjects(change, serverName) ?? [], list })
    },
    Effect.mapError(storage("offers", "Could not read the rules"))
  )

  const offerHistory = Effect.fn("SqlitePermissionStore.offerHistory")(function* (
    runId: string,
    change: PermissionChange
  ): Effect.fn.Return<OfferHistory, PermissionStoreError> {
    const toolName = change.kind === "tool" || change.kind === "site" ? change.tool : null
    const origin = change.kind === "site" ? change.origin : null
    const rows = yield* sql<{
      readonly approvals: number
      readonly offer: OfferHistory["offer"] | null
    }>`
      SELECT
        (SELECT COUNT(*) FROM tool_approvals AS approval
          WHERE approval.session_id = run.session_id AND approval.tool_name = ${toolName}
            AND (${origin} IS NULL
              OR (json_extract(approval.payload_json, '$.approval_data.origin') = ${origin}
                AND json_extract(approval.payload_json, '$.approval_data.reviewer') IS NOT 'user'))
            AND approval.kind = 'tool_approval' AND approval.status = 'approved') AS approvals,
        (SELECT CASE
            WHEN offer.decision = 'no' THEN 'declined'
            WHEN offer.decision IS NOT NULL THEN 'saved'
            WHEN question.question_id IS NULL OR question.closed_at IS NOT NULL THEN 'none'
            ELSE 'open' END
          FROM permission_offers AS offer
          LEFT JOIN run_questions AS question ON question.question_id = offer.question_id
          WHERE offer.session_id = run.session_id AND offer.change_json = ${changeJson(change)}
          ORDER BY offer.created_at DESC LIMIT 1) AS offer
      FROM chat_runs AS run WHERE run.run_id = ${runId}
    `.pipe(Effect.mapError(storage("offers", "Could not read the chat's approvals")))
    return { approvals: rows[0]?.approvals ?? 0, offer: rows[0]?.offer ?? "none" }
  })

  return PermissionStore.of({ offerHolders, allowSaves, offerHistory })
}
