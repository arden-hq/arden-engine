import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const sessionTodos = `CREATE TABLE session_todos (
      session_id TEXT NOT NULL,
      edited INTEGER NOT NULL CHECK(edited IN (0, 1)),
      items_json TEXT NOT NULL,
      explanation TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, edited)
    )`

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE session_todos RENAME TO session_todos_prior")
  database.exec(sessionTodos)
  database.exec(`INSERT INTO session_todos (session_id, edited, items_json, explanation, updated_at)
    SELECT session_id, 0, items_json, explanation, updated_at FROM session_todos_prior
    UNION ALL
    SELECT session_id, 1, items_json, explanation, updated_at FROM session_todo_overrides`)
  database.exec("DROP TABLE session_todos_prior")
  database.exec("DROP TABLE session_todo_overrides")
}

export const oneTodoTable: Migration = {
  version: 35,
  name: "one_todo_table",
  foreignKeys: { kind: "rebuilds", tables: ["session_todos"] },
  up
}
