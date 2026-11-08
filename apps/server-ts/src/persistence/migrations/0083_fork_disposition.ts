import type { Migration } from "./index.js"

export const forkDisposition: Migration = {
  version: 83,
  name: "fork_disposition",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`UPDATE session_fork_requests
      SET request_json = json_set(request_json, '$.disposition', 'retained')
      WHERE json_type(request_json, '$.disposition') IS NULL`)
  }
}
