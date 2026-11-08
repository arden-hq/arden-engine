import type { Migration } from "./index.js"

export const threadLocation: Migration = {
  version: 23,
  name: "thread_location",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE focus_choices ADD COLUMN target_session_id TEXT REFERENCES sessions(session_id) ON DELETE RESTRICT"
    )
    database.exec(
      "ALTER TABLE focus_choices ADD COLUMN transition TEXT CHECK(transition IN ('moved', 'kept', 'typed_here', 'brought_back') OR transition IS NULL)"
    )
    database.exec("ALTER TABLE focus_choices ADD COLUMN transitioned_at TEXT")
    database.exec(`UPDATE focus_choices SET
      transition = CASE decision WHEN 'open_target' THEN 'moved' ELSE 'kept' END,
      transitioned_at = settled_at,
      target_session_id = CASE
        WHEN decision = 'open_target' THEN result_session_id
        WHEN json_extract(target_json, '$.kind') = 'existing'
          AND EXISTS (SELECT 1 FROM sessions WHERE session_id = json_extract(target_json, '$.session_id'))
          THEN json_extract(target_json, '$.session_id')
      END
      WHERE status = 'settled'`)
  }
}
