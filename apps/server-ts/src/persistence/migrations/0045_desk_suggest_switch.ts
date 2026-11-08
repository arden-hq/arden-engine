import type { Migration } from "./index.js"

export const deskSuggestSwitch: Migration = {
  version: 45,
  name: "desk_suggest_switch",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`UPDATE desks
      SET inference_policy = json_set(inference_policy, '$.enabled', json('true')),
        policy_generation = policy_generation + 1
      WHERE autonomy = 'act' AND page_path IS NOT NULL
        AND COALESCE(json_extract(inference_policy, '$.enabled'), 0) != 1`)
    database.exec("ALTER TABLE desks DROP COLUMN autonomy")
  }
}
