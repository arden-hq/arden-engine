import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
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
