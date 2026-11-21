import type { Migration } from "./index.js"

/**
 * A tool call keeps the Task direction its model turn was shown (`{item_id, digest}`), so
 * a paused, approved or restarted call is checked against the plan it was made from, not
 * a newer one. NULL for a call whose turn was shown none, and for every older call.
 *
 * The same release adds a second stored shape, with no SQL: the optional `direction` key
 * (the same `{item_id, digest}`) in a runtime context record's `arden_context_state`,
 * inside `session_messages.message_json`. That is where a call's receipt is read from.
 * Records written before it lack the key, and `RuntimeStateSchema` reads them as before,
 * so no row is rewritten and nothing is backfilled. A Task run's call begun from such a
 * record stores NULL here, and its check asks the model to decide again.
 */
export const toolCallPlannedFrom: Migration = {
  version: 181,
  name: "tool_call_planned_from",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      "ALTER TABLE tool_calls ADD COLUMN planned_from_json TEXT CHECK(planned_from_json IS NULL OR (json_valid(planned_from_json) AND json_type(planned_from_json) = 'object'))"
    )
}
