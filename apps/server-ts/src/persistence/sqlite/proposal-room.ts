import { DateTime, Effect } from "effect"
import { Statement, type SqlClient } from "effect/unstable/sql"
import { ownerPresentSql } from "./home-presence.js"
import { OFFER_EXPIRY_HOURS, OFFER_LATER_HOURS } from "./offer-rules.js"
import type { ProposalRow } from "./task-proposals.js"
import { workError } from "./work-records.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Row } from "effect/unstable/sql/SqlConnection"

const SPACE_OPEN_PROPOSAL_CAP = 3

export const assertOpenProposalRoom = Effect.fn("Work.assertOpenProposalRoom")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly spaceId: string; readonly proposalId: string | undefined }
) {
  const open = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
    FROM task_proposals WHERE place = 'space' AND space_id = ${options.spaceId} AND status = 'offered'
      AND (${options.proposalId ?? null} IS NULL OR proposal_id != ${options.proposalId ?? null})`
  if ((open[0]?.count ?? 0) >= SPACE_OPEN_PROPOSAL_CAP)
    return yield* workError(
      "conflict",
      `This Space already has ${SPACE_OPEN_PROPOSAL_CAP} open proposals; a new one waits until the person settles one. Finish without proposing it.`
    )
})

/** Every write that (re)opens an offer sets this: its expiry clock starts over, unput off and not
 * yet waiting, until the owner is next around. */
export const restartOfferWait = Statement.fragment([
  Statement.literal("put_off_until = NULL, waiting_since = NULL")
])

/** An open offer the owner can see at `at`: offered, and not put off past `at`. Its expiry clock
 * runs only then, and only then is it Home evidence. */
export const offerInSightSql = (
  sql: SqlClient.SqlClient,
  alias: string | undefined,
  at: string
): Statement.Statement<Row> => {
  const column = (name: string) =>
    Statement.fragment([Statement.literal(alias === undefined ? name : `${alias}.${name}`)])
  return sql`(${column("status")} = 'offered'
    AND (${column("put_off_until")} IS NULL OR ${column("put_off_until")} <= ${at}))`
}

/** The owner's Later: the offer stays open but out of sight for `OFFER_LATER_HOURS`, and its
 * expiry clock starts over once it is back. */
export const putOfferOff = (
  sql: SqlClient.SqlClient,
  proposalId: string,
  now: DateTime.Utc
): Effect.Effect<void, SqlError, never> =>
  sql`UPDATE task_proposals SET revision = revision + 1, updated_at = ${DateTime.formatIso(now)},
    ${restartOfferWait},
    put_off_until = ${DateTime.formatIso(DateTime.add(now, { hours: OFFER_LATER_HOURS }))}
    WHERE proposal_id = ${proposalId} AND status = 'offered'`.pipe(Effect.asVoid)

export const expireOverdueOffers = Effect.fn("Work.expireOverdueOffers")(function* (
  sql: SqlClient.SqlClient,
  now: DateTime.Utc
) {
  const at = DateTime.formatIso(now)
  const cutoff = DateTime.formatIso(DateTime.subtract(now, { hours: OFFER_EXPIRY_HOURS }))
  yield* sql`UPDATE task_proposals SET waiting_since = ${at}
    WHERE ${offerInSightSql(sql, undefined, at)} AND waiting_since IS NULL
      AND ${ownerPresentSql(sql, at)}`
  const overdue = yield* sql<ProposalRow>`SELECT * FROM task_proposals
    WHERE status = 'offered' AND waiting_since <= ${cutoff}
    ORDER BY seq`
  if (overdue.length === 0) return overdue
  yield* sql`UPDATE task_proposals SET status = 'expired', revision = revision + 1,
    updated_at = ${at}, settled_at = ${at}
    WHERE proposal_id IN ${sql.in(overdue.map((row) => row.proposal_id))}`
  return overdue
})
