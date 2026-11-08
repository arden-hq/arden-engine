import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE scheduled_tasks ADD COLUMN prompt_author TEXT CHECK(prompt_author IN ('owner', 'agent'))"
  )
}

export const automationPromptAuthor: Migration = {
  version: 75,
  name: "automation_prompt_author",
  foreignKeys: { kind: "enforced" },
  up
}
