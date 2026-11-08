import type { SqlClient, Statement } from "effect/unstable/sql"
import { declaredNewsSql, quietRunSql, runChangedSql } from "../schema/run-change.js"

export const quietRunOutcome = (
  sql: SqlClient.SqlClient,
  run: "run" | "chat"
): Statement.Fragment => sql.literal(quietRunSql(`${run}.run_id`, `${run}.metadata_json`))

export const changedRunOutcome = (
  sql: SqlClient.SqlClient,
  run: "run" | "chat"
): Statement.Fragment => sql.literal(runChangedSql(`${run}.run_id`))

export const newsRunOutcome = (sql: SqlClient.SqlClient, run: "run" | "chat"): Statement.Fragment =>
  sql.literal(declaredNewsSql(`${run}.run_id`))
