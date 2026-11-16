import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * The model endpoint settings document gains `chat`, the saved model server
 * (`StoredChatEndpoint`), null until one is saved. A JSON document in
 * `monitor_state`, so no table changes and no schema section.
 */
const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE monitor_state SET state = json_set(state, '$.chat', json('null'))
    WHERE namespace = 'model_endpoint_settings' AND json_valid(state)`)
}

export const modelServerEndpoint: Migration = {
  version: 170,
  name: "model_server_endpoint",
  foreignKeys: { kind: "enforced" },
  up
}
