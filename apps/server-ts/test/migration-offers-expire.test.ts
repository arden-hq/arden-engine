import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { dropInferenceRejections } from "../src/persistence/migrations/0159_drop_inference_rejections.js"
import { offersExpire } from "../src/persistence/migrations/0160_offers_expire.js"
import { migrations } from "../src/persistence/migrations/index.js"

const at = "2026-10-01T00:00:00.000Z"

it("migrations 0159 and 0160 drop the dead rejections table and let an offer expire, rows unchanged", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter(
    (entry) => entry.version < dropInferenceRejections.version
  ))
    migration.up(database)
  database.exec(`INSERT INTO task_inference_rejections (item_id, space_id, evidence_key, sources,
      reason, created_at) VALUES ('task-x', 'space-x', 'key', '[]', 'Made up.', '${at}')`)
  const offer = database.prepare(`INSERT INTO task_proposals (proposal_id, place, dedupe_key,
      stable_key, text, owner, capture_json, sources_json, evidence_revision_key, candidate_hash,
      revision, seq, status, created_at, updated_at)
    VALUES (?, 'home', ?, ?, 'Made-up offer', 'worker', '{"basis":"inferred","reason":"r"}', '[]',
      ?, ?, 0, ?, ?, '${at}', '${at}')`)
  offer.run("offer_a", "home:a", "a", "home:a", "home:a", 1, "offered")
  offer.run("offer_b", "home:b", "b", "home:b", "home:b", 2, "held")
  const before = database.prepare("SELECT * FROM task_proposals ORDER BY seq").all()

  dropInferenceRejections.up(database)
  offersExpire.up(database)

  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE name = 'task_inference_rejections'")
    .all()
  expect(tables).toEqual([])
  expect(database.prepare("SELECT * FROM task_proposals ORDER BY seq").all()).toEqual(before)
  database.exec(`UPDATE task_proposals SET status = 'expired', revision = 1,
    updated_at = '2026-10-04T00:00:00.000Z', settled_at = '2026-10-04T00:00:00.000Z'
    WHERE proposal_id = 'offer_a'`)
  const history = database
    .prepare(`SELECT kind, json_extract(state_json, '$.status') AS status
      FROM task_proposal_revisions WHERE proposal_id = 'offer_a' ORDER BY version`)
    .all()
    .map((row) => [row.kind, row.status])
  expect(history).toEqual([
    ["created", "offered"],
    ["changed", "expired"]
  ])
  expect(() =>
    database.exec(`UPDATE task_proposals SET status = 'expired', settled_at = '${at}',
      settlement_client_id = 'client', settlement_decision = 'reject' WHERE proposal_id = 'offer_b'`)
  ).toThrow(/CHECK constraint failed/u)
})
