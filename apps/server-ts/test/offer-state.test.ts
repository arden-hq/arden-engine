import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import { OFFER_EXPIRY_HOURS } from "../src/persistence/sqlite/offer-rules.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const NOW = Date.now()
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()

const mainOffer = (sql: SqlClient.SqlClient, id: string, hoursAgo: number) =>
  sql`INSERT INTO task_proposals (proposal_id, place, space_id, dedupe_key, stable_key, text, owner,
      capture_json, sources_json, evidence_revision_key, candidate_hash, revision, seq,
      status, created_at, updated_at)
    VALUES (${id}, 'space', (SELECT space_id FROM spaces WHERE kind = 'main'), ${`main:${id}`},
      ${id}, 'Made-up offer', 'worker',
      '{"basis":"inferred","reason":"Made up."}', '[]', ${id}, ${id}, 0, 1,
      'offered', ${at(hoursAgo)}, ${at(hoursAgo)})`

const states = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly proposal_id: string
    readonly status: string
    readonly revision: number
    readonly waiting_since: string | null
  }>`SELECT proposal_id, status, revision, waiting_since FROM task_proposals ORDER BY proposal_id`.pipe(
    Effect.map((rows) =>
      Object.fromEntries(
        rows.map((row) => [
          row.proposal_id,
          { status: row.status, revision: row.revision, clockStarted: row.waiting_since !== null }
        ])
      )
    )
  )

it("an offer expires only after the owner was around to see it", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* mainOffer(sql, "offer_a", OFFER_EXPIRY_HOURS + 300)
      const away = [yield* proposals.expireOffers(), yield* states(sql)]
      yield* sql`INSERT INTO home_presence (client_id, sequence, last_seen_at, lease_until)
        VALUES ('c', 1, ${at(0)}, ${new Date(Date.now() + 30_000).toISOString()})`
      yield* mainOffer(sql, "offer_b", 1)
      yield* sql`UPDATE task_proposals SET waiting_since = ${at(OFFER_EXPIRY_HOURS + 1)}
        WHERE proposal_id = 'offer_a'`
      yield* sql`UPDATE task_proposals SET waiting_since = ${at(1)} WHERE proposal_id = 'offer_b'`
      const overdue = [yield* proposals.expireOffers(), yield* states(sql)]
      return { away, overdue }
    })
  )
  expect(outcome.away).toEqual([
    0,
    { offer_a: { status: "offered", revision: 0, clockStarted: false } }
  ])
  expect(outcome.overdue).toEqual([
    1,
    {
      offer_a: { status: "expired", revision: 1, clockStarted: true },
      offer_b: { status: "offered", revision: 0, clockStarted: true }
    }
  ])
})
