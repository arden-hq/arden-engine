import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const deskTaskComments = `CREATE TABLE desk_task_comments (
      comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','ask'))
    )`

const up = (database: DatabaseSync): void => {
  convertDoneResults(database)
  database.exec("DROP INDEX idx_desk_task_comments_result")
  database.exec("DROP INDEX idx_desk_task_comments_desk_created")
  database.exec("ALTER TABLE desk_task_comments RENAME TO desk_task_comments_prior")
  database.exec(deskTaskComments)
  database.exec(`INSERT INTO desk_task_comments (comment_id, desk_id, item_id, author, body, created_at, kind)
    SELECT comment_id, desk_id, item_id, author, body, created_at,
      CASE WHEN kind = 'result' THEN 'note' ELSE kind END
    FROM desk_task_comments_prior`)
  database.exec("DROP TABLE desk_task_comments_prior")
  database.exec(`CREATE INDEX idx_desk_task_comments_desk_created
      ON desk_task_comments(desk_id, created_at DESC)`)
}

const convertDoneResults = (database: DatabaseSync): void => {
  const results = database
    .prepare(
      `SELECT comment.comment_id, comment.desk_id, comment.item_id, comment.body,
        comment.result_summary, comment.created_at
      FROM desk_task_comments AS comment
      JOIN desk_tasks AS task ON task.item_id = comment.item_id
      WHERE comment.kind = 'result' AND task.status = 'done'
      ORDER BY comment.created_at, comment.comment_id`
    )
    .all()
  const insertEvent = database.prepare(
    `INSERT INTO desk_task_events (desk_id, item_id, event_type, summary, result_summary, content_kind, created_at)
    VALUES (?, ?, 'done', ?, ?, 'result', ?)`
  )
  const keepSeen = database.prepare(
    "UPDATE desk_task_result_reads SET result_key = ? WHERE item_id = ? AND result_key = ?"
  )
  const removeComment = database.prepare("DELETE FROM desk_task_comments WHERE comment_id = ?")
  for (const row of results) {
    const itemId = String(row.item_id)
    const resultSummary = row.result_summary === null ? null : String(row.result_summary)
    const event = insertEvent.run(
      String(row.desk_id),
      itemId,
      String(row.body),
      resultSummary,
      String(row.created_at)
    )
    keepSeen.run(
      `event:${String(event.lastInsertRowid)}`,
      itemId,
      `comment:${String(row.comment_id)}`
    )
    removeComment.run(Number(row.comment_id))
  }
}

export const taskCommentsAreNotes: Migration = {
  version: 37,
  name: "task_comments_are_notes",
  foreignKeys: { kind: "rebuilds", tables: ["desk_task_comments", "desk_task_events"] },
  up
}
