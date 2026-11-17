import { Statement, type SqlClient } from "effect/unstable/sql"
import type { Actor } from "../../execution/authority.js"
import { OWNER_FACING_HANDLERS } from "../automations/model.js"

const PERSON = "person" satisfies Actor["kind"]
const AGENT = "agent" satisfies Actor["kind"]
const AUTOMATION = "automation" satisfies Actor["kind"]
const USER_AUTOMATION = "user_automation" satisfies Extract<
  Actor,
  { kind: "automation" }
>["purpose"]

const actorKind = (sql: SqlClient.SqlClient, authority: Statement.Fragment) =>
  sql`json_extract(${authority}, '$.actor.kind')`

export const personRunSql = (
  sql: SqlClient.SqlClient,
  authority: Statement.Fragment
): Statement.Fragment => sql`COALESCE(${actorKind(sql, authority)} = ${PERSON}, 0)`

export const actsAsPersonSql = (
  sql: SqlClient.SqlClient,
  authority: Statement.Fragment
): Statement.Fragment =>
  sql`(${personRunSql(sql, authority)}
    OR COALESCE(${actorKind(sql, authority)} = ${AUTOMATION}
      AND json_extract(${authority}, '$.actor.purpose') = ${USER_AUTOMATION}, 0))`

export const takesAnswersMidRunSql = (
  sql: SqlClient.SqlClient,
  authority: Statement.Fragment,
  agentChat: Statement.Fragment
): Statement.Fragment =>
  sql`(${personRunSql(sql, authority)}
    OR COALESCE(${actorKind(sql, authority)} = ${AGENT} AND ${agentChat}, 0))`

export const userAutomationSql = (alias?: string): Statement.Fragment =>
  Statement.fragment([
    Statement.literal(`${alias === undefined ? "" : `${alias}.`}purpose = '${USER_AUTOMATION}'`)
  ])

/** An Automation whose runs speak to the owner: the owner's own, or a system one that tells them
 *  something (`OWNER_FACING_HANDLERS`). These pause when they give up and are tried again. */
export const ownerFacingAutomationSql = (alias?: string): Statement.Fragment => {
  const column = alias === undefined ? "" : `${alias}.`
  const handlers = OWNER_FACING_HANDLERS.map((handler) => `'${handler}'`).join(", ")
  return Statement.fragment([
    Statement.literal(
      `(${column}purpose = '${USER_AUTOMATION}' OR ${column}handler IN (${handlers}))`
    )
  ])
}
