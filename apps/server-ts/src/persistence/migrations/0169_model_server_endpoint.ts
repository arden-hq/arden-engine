import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE monitor_state SET state = json_set(state, '$.chat', json('[]'))
    WHERE namespace = 'model_endpoint_settings' AND json_valid(state)`)
}

export const modelServerEndpoint: Migration = {
  version: 169,
  name: "model_server_endpoint",
  foreignKeys: { kind: "enforced" },
  up
}
