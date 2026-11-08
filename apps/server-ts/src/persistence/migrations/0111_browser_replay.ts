import type { Migration } from "./index.js"

const browserReplays = `CREATE TABLE browser_replays (
      origin TEXT NOT NULL CHECK (length(origin) > 0),
      path TEXT NOT NULL,
      goal TEXT NOT NULL CHECK (length(goal) > 0),
      page TEXT NOT NULL CHECK (length(page) > 0),
      values_key TEXT NOT NULL CHECK (length(values_key) > 0),
      steps_json TEXT NOT NULL CHECK (json_valid(steps_json) AND json_type(steps_json) = 'array'),
      steps_key TEXT NOT NULL CHECK (length(steps_key) > 0),
      agreed INTEGER NOT NULL CHECK (agreed IN (0, 1)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (origin, path, goal)
    )`

export const browserReplay: Migration = {
  version: 111,
  name: "browser_replay",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(browserReplays)
  }
}
