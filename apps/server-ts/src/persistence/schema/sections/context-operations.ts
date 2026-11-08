import type { OperationalSchemaSection } from "../section.js"

export const contextOperationsSchemaSection = {
  name: "context.operations",
  storageDomain: "operations",
  tables: ["letter_subjects", "usage_daily"],
  indexes: [],
  triggers: [],
  statements: [
    `CREATE TABLE letter_subjects (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id)
    )`,
    `CREATE TABLE usage_daily (
      day TEXT NOT NULL CHECK(length(day) = 10),
      space_id TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'automation')),
      session_type TEXT NOT NULL CHECK(session_type IN ('', 'chat', 'channel', 'agent')),
      model_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('chat', 'chat_title', 'letter_subject', 'chat_triage', 'focus_offer', 'space_overview', 'space_instructions', 'automation_description', 'recipe_draft', 'capture', 'item_routing', 'helper_review', 'claim_check', 'compaction', 'automation_prefilter', 'space_review_gate', 'composer_shortcut', 'run_activity')),
      total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
      runs INTEGER NOT NULL DEFAULT 0 CHECK(runs >= 0),
      PRIMARY KEY (day, space_id, origin, session_type, model_id, kind)
    )`
  ]
} as const satisfies OperationalSchemaSection
