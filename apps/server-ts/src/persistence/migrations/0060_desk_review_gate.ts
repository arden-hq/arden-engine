import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const usageDaily = `CREATE TABLE usage_daily (
      day TEXT NOT NULL CHECK(length(day) = 10),
      desk_id TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'automation')),
      session_type TEXT NOT NULL CHECK(session_type IN ('', 'chat', 'channel', 'agent')),
      model_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('chat', 'chat_title', 'letter_subject', 'chat_triage', 'focus_offer', 'desk_overview', 'desk_instructions', 'automation_description', 'recipe_draft', 'capture', 'item_routing', 'helper_review', 'claim_check', 'compaction', 'automation_prefilter', 'desk_review_gate')),
      total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
      runs INTEGER NOT NULL DEFAULT 0 CHECK(runs >= 0),
      PRIMARY KEY (day, desk_id, origin, session_type, model_id, kind)
    )`

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE usage_daily RENAME TO usage_daily_prior")
  database.exec(usageDaily)
  database.exec(`INSERT INTO usage_daily (
      day, desk_id, origin, session_type, model_id, kind,
      total_tokens, output_tokens, cache_read_tokens, cache_write_tokens, runs
    )
    SELECT day, desk_id, origin, session_type, model_id, kind,
      total_tokens, output_tokens, cache_read_tokens, cache_write_tokens, runs
    FROM usage_daily_prior`)
  database.exec("DROP TABLE usage_daily_prior")
}

export const deskReviewGate: Migration = {
  version: 60,
  name: "desk_review_gate",
  foreignKeys: { kind: "rebuilds", tables: ["usage_daily"] },
  up
}
