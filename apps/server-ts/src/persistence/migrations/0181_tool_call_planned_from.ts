import type { Migration } from "./index.js"

export const toolCallPlannedFrom: Migration = {
  version: 181,
  name: "tool_call_planned_from",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      "ALTER TABLE tool_calls ADD COLUMN planned_from_json TEXT CHECK(planned_from_json IS NULL OR (json_valid(planned_from_json) AND json_type(planned_from_json) = 'object'))"
    )
}
