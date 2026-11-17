import {
  VAULT_KEY_RULES_FROM_RULE,
  VAULT_KEY_RULES_IDENTITY,
  VAULT_KEY_RULES_TABLE
} from "../../migrations/0170_vault_key_rules.js"
import type { OperationalSchemaSection } from "../section.js"

export const capabilitiesSchemaSection = {
  name: "capabilities",
  storageDomain: "configuration",
  tables: ["mcp_servers", "permission_rules", "permission_settings", "capability_offers"],
  indexes: [
    "idx_permission_rules_identity",
    "idx_capability_offers_open",
    "idx_permission_rules_from_rule_id",
    "idx_permission_rules_server_name",
    "idx_permission_rules_source_question_id",
    "idx_permission_rules_space_id"
  ],
  triggers: ["space_archive_drops_rules"],
  statements: [
    `CREATE TABLE mcp_servers (
      name TEXT PRIMARY KEY,
      preset_id TEXT CHECK(preset_id IN (
        'github',
        'linear',
        'notion',
        'slack',
        'vercel'
      )),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      transport_json TEXT NOT NULL
        CHECK(json_valid(transport_json) AND json_type(transport_json) = 'object'),
      updated_at TEXT NOT NULL
    )`,
    VAULT_KEY_RULES_TABLE,
    VAULT_KEY_RULES_FROM_RULE,
    VAULT_KEY_RULES_IDENTITY,
    `CREATE TRIGGER space_archive_drops_rules AFTER UPDATE OF archived_at ON spaces
      WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL BEGIN
      DELETE FROM permission_rules WHERE list_kind = 'space' AND space_id = NEW.space_id;
    END`,
    `CREATE TABLE permission_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      default_mode TEXT NOT NULL DEFAULT 'safe'
        CHECK(default_mode IN ('read_only', 'ask', 'safe', 'allow'))
    )`,
    "INSERT INTO permission_settings (singleton_id) VALUES (1)",
    `CREATE TABLE capability_offers (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      candidates_json TEXT NOT NULL
        CHECK(json_valid(candidates_json) AND json_type(candidates_json) = 'array'),
      offered_at TEXT NOT NULL,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('connected', 'declined', 'expired')),
      outcome_at TEXT,
      PRIMARY KEY (session_id, tool_call_id),
      CHECK((outcome IS NULL) = (outcome_at IS NULL))
    )`,
    "CREATE INDEX idx_capability_offers_open ON capability_offers(offered_at) WHERE outcome IS NULL",
    "CREATE INDEX idx_permission_rules_from_rule_id ON permission_rules(from_rule_id)",
    "CREATE INDEX idx_permission_rules_server_name ON permission_rules(server_name)",
    "CREATE INDEX idx_permission_rules_source_question_id ON permission_rules(source_question_id)",
    "CREATE INDEX idx_permission_rules_space_id ON permission_rules(space_id)"
  ]
} as const satisfies OperationalSchemaSection
