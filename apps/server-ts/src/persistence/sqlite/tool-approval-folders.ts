import { Effect, Result } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { JsonObject } from "../json.js"
import { ToolExecutionStoreError, type ToolExecutionIdentity } from "../tools/store.js"
import { spaceFolderGrantOf } from "../permissions/space-folder-approval.js"
import { saveRuleInTransaction } from "./permission-rules.js"
import type { RuleList } from "../permissions/rules.js"
import { toolError, type ApprovalRow } from "./tool-rows.js"

interface SpaceFolderRow {
  readonly space_id: string
}

export type ApprovalFolderResolutions = ReadonlyMap<string, Result.Result<string, unknown>>

const requireApprovedFolder = Effect.fn("SqliteToolExecutionStore.requireApprovedFolder")(
  function* (
    folders: ApprovalFolderResolutions,
    localFolder: string,
    identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">
  ): Effect.fn.Return<void, ToolExecutionStoreError> {
    const resolution = folders.get(localFolder)
    if (resolution === undefined) {
      return yield* toolError(
        "resolve",
        "conflict",
        "The approved Local folder changed after approval was requested",
        identity
      )
    }
    if (Result.isFailure(resolution)) {
      return yield* toolError(
        "resolve",
        "conflict",
        "The approved Local folder is no longer available",
        identity,
        resolution.failure
      )
    }
    if (resolution.success !== localFolder) {
      return yield* toolError(
        "resolve",
        "conflict",
        "The approved Local folder now resolves somewhere else",
        identity
      )
    }
  }
)

export const attachFolderToSpaceInTransaction = Effect.fn(
  "SqliteToolExecutionStore.attachFolderToSpaceInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  approval: ApprovalRow,
  payload: JsonObject,
  approvedFolders: ApprovalFolderResolutions,
  identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">
): Effect.fn.Return<void, ToolExecutionStoreError> {
  const grant =
    approval.kind === "tool_approval"
      ? spaceFolderGrantOf(approval.tool_name, payload["approval_data"])
      : undefined
  if (grant === undefined) {
    return yield* toolError(
      "resolve",
      "blocked",
      "This approval cannot attach a Local folder to a Space",
      identity
    )
  }
  const localFolder = grant.local_folder
  yield* requireApprovedFolder(approvedFolders, localFolder, identity)
  const rows = yield* sql<SpaceFolderRow>`
    SELECT space.space_id
    FROM sessions AS session
    JOIN spaces AS space ON space.space_id = session.space_id
    WHERE session.session_id = ${approval.session_id}
      AND session.archived_at IS NULL
      AND session.space_id = ${grant.space_id}
      AND space.archived_at IS NULL
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      toolError(
        "resolve",
        "storage",
        "Could not read the Space for this Local folder approval",
        identity,
        cause
      )
    )
  )
  const row = rows[0]
  if (row === undefined) {
    return yield* toolError(
      "resolve",
      "conflict",
      "The Session's Space changed after approval was requested",
      identity
    )
  }
  yield* saveFolderRule(sql, { kind: "space", spaceId: row.space_id }, localFolder, identity)
})

const saveFolderRule = (
  sql: SqlClient.SqlClient,
  list: RuleList,
  folder: string,
  identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">
) =>
  saveRuleInTransaction(sql, {
    subject: { kind: "path", path: folder, access: "change" },
    list,
    decision: "allow",
    source: { kind: "card", runId: identity.runId, toolCallId: identity.toolCallId }
  }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => toolError("resolve", "blocked", cause.message, identity, cause))
  )
