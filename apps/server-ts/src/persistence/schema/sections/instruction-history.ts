import type { OperationalSchemaSection } from "../section.js"

export const instructionHistorySchemaSection = {
  name: "instruction-history",
  storageDomain: "configuration",
  tables: ["global_instruction_versions"],
  indexes: [],
  triggers: ["global_instruction_versions_immutable", "global_instruction_versions_kept"],
  statements: [
    `CREATE TABLE global_instruction_versions (
      version INTEGER PRIMARY KEY CHECK(version > 0),
      content TEXT NOT NULL,
      digest TEXT NOT NULL CHECK(length(digest) > 0),
      writer TEXT NOT NULL CHECK(writer IN ('seed', 'outside', 'chat', 'restore')),
      session_id TEXT,
      run_id TEXT,
      restored_from INTEGER CHECK(restored_from IS NULL OR (restored_from > 0 AND restored_from < version)),
      recorded_at TEXT NOT NULL,
      CHECK((writer IN ('chat', 'restore')) = (session_id IS NOT NULL AND run_id IS NOT NULL)),
      CHECK((writer = 'restore') = (restored_from IS NOT NULL))
    )`,
    `CREATE TRIGGER global_instruction_versions_immutable
      BEFORE UPDATE ON global_instruction_versions
      BEGIN SELECT RAISE(ABORT, 'Instruction versions are immutable'); END`,
    `CREATE TRIGGER global_instruction_versions_kept
      BEFORE DELETE ON global_instruction_versions
      BEGIN SELECT RAISE(ABORT, 'Instruction versions are kept'); END`
  ]
} as const satisfies OperationalSchemaSection
