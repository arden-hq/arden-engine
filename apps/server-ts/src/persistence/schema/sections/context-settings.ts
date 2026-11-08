import type { OperationalSchemaSection } from "../section.js"

export const contextSettingsSchemaSection = {
  name: "context.settings",
  storageDomain: "configuration",
  tables: ["model_settings"],
  indexes: [],
  triggers: [],
  statements: [
    `CREATE TABLE model_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      settings_json TEXT CHECK(settings_json IS NULL OR (json_valid(settings_json) AND json_type(settings_json) = 'object'))
    )`,
    "INSERT INTO model_settings (singleton_id) VALUES (1)"
  ]
} as const satisfies OperationalSchemaSection
