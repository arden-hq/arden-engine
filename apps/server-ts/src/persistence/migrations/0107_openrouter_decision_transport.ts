import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE monitor_state SET state = json_set(state, '$.decision.input', 'text')
    WHERE namespace = 'model_endpoint_settings' AND json_valid(state)
      AND json_extract(state, '$.decision.format') = 'systemone'
      AND json_extract(state, '$.decision.input') = 'text+image'`)
  database.exec(`UPDATE monitor_state
    SET state = json_set(state, '$.decision.format', 'openrouter-decisions',
      '$.decision.baseUrl', 'https://openrouter.ai/api', '$.decision.input', 'text')
    WHERE namespace = 'model_endpoint_settings' AND json_valid(state)
      AND json_extract(state, '$.decision.format') = 'systemone'
      AND rtrim(json_extract(state, '$.decision.baseUrl'), '/') IN
        ('https://openrouter.ai/api', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/systemone')`)
}

export const openrouterDecisionTransport: Migration = {
  version: 107,
  name: "openrouter_decision_transport",
  foreignKeys: { kind: "enforced" },
  up
}
