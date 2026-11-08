import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "@arden-hq/protocol/permissions"

export const defaultModeSql = (sql: SqlClient.SqlClient) =>
  sql`COALESCE((SELECT default_mode FROM permission_settings WHERE singleton_id = 1),
    ${DEFAULT_APPROVAL_MODE})`

export const readDefaultApprovalMode = Effect.fn("DefaultApprovalMode.read")(function* (
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql<{ readonly mode: string }>`SELECT ${defaultModeSql(sql)} AS mode`
  return yield* Schema.decodeUnknownEffect(ApprovalModeSchema)(rows[0]?.mode)
})

export const writeDefaultApprovalMode = (sql: SqlClient.SqlClient, mode: ApprovalMode) =>
  sql`INSERT INTO permission_settings (singleton_id, default_mode) VALUES (1, ${mode})
    ON CONFLICT (singleton_id) DO UPDATE SET default_mode = excluded.default_mode`
