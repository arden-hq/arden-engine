import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE permission_rules ADD COLUMN from_rule_id TEXT REFERENCES permission_rules(rule_id) ON DELETE CASCADE"
  )
  const said = database
    .prepare(
      "SELECT rule_id, list_kind, desk_id, decision, said FROM permission_rules WHERE said IS NOT NULL"
    )
    .all()
  const insert = database.prepare(`INSERT OR IGNORE INTO permission_rules (
      rule_id, list_kind, desk_id, subject_kind, words, decision, source_kind, created_at
    ) VALUES (?, ?, ?, 'words', ?, ?, 'settings', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  const words = database.prepare(`SELECT rule_id FROM permission_rules
    WHERE subject_kind = 'words' AND list_kind = ? AND desk_id IS ? AND words = ?`)
  const link = database.prepare("UPDATE permission_rules SET from_rule_id = ? WHERE rule_id = ?")
  for (const rule of said) {
    insert.run(
      `words-${String(rule["rule_id"])}`,
      rule["list_kind"] as string,
      rule["desk_id"] as string | null,
      rule["said"] as string,
      rule["decision"] as string
    )
    const parent = words.get(
      rule["list_kind"] as string,
      rule["desk_id"] as string | null,
      rule["said"] as string
    )
    if (parent !== undefined) link.run(parent["rule_id"] as string, rule["rule_id"] as string)
  }
  database.exec("ALTER TABLE permission_rules DROP COLUMN said")
}

export const compiledRules: Migration = {
  version: 133,
  name: "compiled_rules",
  foreignKeys: { kind: "enforced" },
  up
}
