import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import { OFFER_EXPIRY_HOURS } from "../src/persistence/sqlite/offer-rules.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const NOW = Date.now()
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()

const homeOffer = (sql: SqlClient.SqlClient, id: string, hoursAgo: number) =>
  sql`INSERT INTO task_proposals (proposal_id, place, dedupe_key, stable_key, text, owner,
      capture_json, sources_json, evidence_revision_key, candidate_hash, revision, seq,
      status, created_at, updated_at)
    VALUES (${id}, 'home', ${`home:${id}`}, ${id}, 'Made-up offer', 'worker',
      '{"basis":"inferred","reason":"Made up."}', '[]', ${id}, ${id}, 0, 1,
      'offered', ${at(hoursAgo)}, ${at(hoursAgo)})`

const status = (sql: SqlClient.SqlClient) =>
  sql<{ readonly status: string }>`SELECT status FROM task_proposals`.pipe(
    Effect.map((rows) => rows[0]?.status)
  )

it("an offer expires only after the owner was around to see it", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* homeOffer(sql, "offer_a", OFFER_EXPIRY_HOURS + 300)
      const away = [yield* proposals.expireOffers(), yield* status(sql)]
      yield* sql`INSERT INTO home_presence (client_id, sequence, last_seen_at, lease_until)
        VALUES ('c', 1, ${at(0)}, ${new Date(Date.now() + 30_000).toISOString()})`
      yield* sql`UPDATE task_proposals SET waiting_since = ${at(OFFER_EXPIRY_HOURS + 1)}`
      const overdue = [yield* proposals.expireOffers(), yield* status(sql)]
      return { away, overdue }
    })
  )
  expect(outcome).toEqual({
    away: [0, "offered"],
    overdue: [1, "expired"]
  })
})
