import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { OFFER_EXPIRY_HOURS } from "./offer-rules.js"
import type { ProposalRow } from "./task-proposals.js"
import { workError } from "./work-records.js"

const SPACE_OPEN_PROPOSAL_CAP = 3

export const HOME_OPEN_PROPOSAL_CAP = 5

export const assertOpenProposalRoom = Effect.fn("Work.assertOpenProposalRoom")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly spaceId: string; readonly proposalId: string | undefined }
) {
  const open = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
    FROM task_proposals WHERE place = 'space' AND space_id = ${options.spaceId} AND status = 'offered'
      AND proposal_id != ${options.proposalId ?? ""}`
  if ((open[0]?.count ?? 0) >= SPACE_OPEN_PROPOSAL_CAP)
    return yield* workError(
      "conflict",
      `This Space already has ${SPACE_OPEN_PROPOSAL_CAP} open proposals; a new one waits until the person settles one. Finish without proposing it.`
    )
})

export const assertHomeProposalRoom = Effect.fn("Work.assertHomeProposalRoom")(function* (
  sql: SqlClient.SqlClient,
  proposalId: string
) {
  const open = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
    FROM task_proposals WHERE place = 'home' AND status = 'offered'
      AND proposal_id != ${proposalId}`
  if ((open[0]?.count ?? 0) >= HOME_OPEN_PROPOSAL_CAP)
    return yield* workError(
      "conflict",
      `Home already has ${HOME_OPEN_PROPOSAL_CAP} open suggestions; a new one waits until the person settles one. Finish without proposing it.`
    )
})

export const openHeldOnHome = (sql: SqlClient.SqlClient, now: string) =>
  sql`UPDATE task_proposals SET status = 'offered', revision = revision + 1, updated_at = ${now}
    WHERE proposal_id IN (SELECT proposal_id FROM task_proposals
      WHERE place = 'home' AND status = 'held'
      ORDER BY seq
      LIMIT MAX(0, ${HOME_OPEN_PROPOSAL_CAP} - (SELECT COUNT(*) FROM task_proposals
        WHERE place = 'home' AND status = 'offered')))`.pipe(Effect.asVoid)

/** Moves every offer left unanswered for `OFFER_EXPIRY_HOURS` since it was last offered or
 * revised to `expired`, then lets held Home offers take the room. A held offer's clock starts
 * when it moves up. Returns the offers that expired. */
export const expireOverdueOffers = Effect.fn("Work.expireOverdueOffers")(function* (
  sql: SqlClient.SqlClient,
  now: DateTime.Utc
) {
  const at = DateTime.formatIso(now)
  const cutoff = DateTime.formatIso(DateTime.subtract(now, { hours: OFFER_EXPIRY_HOURS }))
  const overdue = yield* sql<ProposalRow>`SELECT * FROM task_proposals
    WHERE place IN ('space', 'chat', 'home') AND status = 'offered' AND updated_at <= ${cutoff}
    ORDER BY seq`
  if (overdue.length === 0) return overdue
  yield* sql`UPDATE task_proposals SET status = 'expired', revision = revision + 1,
    updated_at = ${at}, settled_at = ${at}
    WHERE proposal_id IN ${sql.in(overdue.map((row) => row.proposal_id))}`
  yield* openHeldOnHome(sql, at)
  return overdue
})
