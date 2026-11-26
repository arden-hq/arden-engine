import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const stop = (column: string, path: string): string =>
  `json(CASE WHEN json_type(${column}, '${path}') IN ('integer', 'real')
    THEN json_object('kind', 'at', 'percent', json_extract(${column}, '${path}'))
    ELSE json_object('kind', 'unlimited') END)`

const cap = (column: string, path: string): string =>
  `json(CASE WHEN json_type(${column}, '${path}') IN ('integer', 'real')
    THEN json_object('kind', 'capped', 'tokens', json_extract(${column}, '${path}'))
    ELSE json_object('kind', 'uncapped') END)`

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE monitor_state SET state = json_object(
      'ardenLimit', ${stop("state", "$.ardenLimitPercent")},
      'backgroundLimit', ${stop("state", "$.backgroundLimitPercent")},
      'keepGoing', json(CASE WHEN json_type(state, '$.keepGoingUntil') = 'text'
        THEN json_object('kind', 'until', 'until', json_extract(state, '$.keepGoingUntil'))
        ELSE json_object('kind', 'off') END),
      'automationLimits', json((SELECT json_group_object(limits.key, json_object(
          'pause', ${stop("limits.value", "$.pauseAtPercent")},
          'cap', ${cap("limits.value", "$.maxTokensPerRun")}))
        FROM json_each(state, '$.automationLimits') AS limits)))
    WHERE namespace = 'limit_settings' AND json_valid(state)
      AND json_type(state, '$.ardenLimit') IS NULL`)
}

export const limitSettingsStates: Migration = {
  version: 193,
  name: "limit_settings_states",
  foreignKeys: { kind: "enforced" },
  up
}
