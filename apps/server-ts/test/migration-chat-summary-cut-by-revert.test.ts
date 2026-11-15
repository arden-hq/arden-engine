import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { chatSummaryCutByRevert } from "../src/persistence/migrations/0164_chat_summary_cut_by_revert.js"
import { migrations } from "../src/persistence/migrations/index.js"

const at = "2026-11-01T00:00:00.000Z"

it("migration 0164 removes each stored chat summary ahead of its chat, and the trigger removes later ones", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter(
    (entry) => entry.version < chatSummaryCutByRevert.version
  ))
    migration.up(database)
  const message = database.prepare(`INSERT INTO session_messages
      (session_id, message_id, seq, role, message_json, created_at) VALUES (?, ?, ?, 'user', '{}', '${at}')`)
  const summary = database.prepare(`INSERT INTO chat_summaries
      (session_id, title, summary, through_sequence, updated_at) VALUES (?, 'Made up', 'Made up.', ?, '${at}')`)
  for (const seq of [0, 1, 2]) message.run("ahead", `ahead-${seq}`, seq)
  for (const seq of [0, 1, 2]) message.run("behind", `behind-${seq}`, seq)
  summary.run("ahead", 9)
  summary.run("behind", 1)
  summary.run("empty", 4)
  summary.run("before", 0)
  message.run("before", "before-0", 0)
  message.run("before", "before-1", 1)

  chatSummaryCutByRevert.up(database)
  const stored = () =>
    database
      .prepare("SELECT session_id, through_sequence FROM chat_summaries ORDER BY session_id")
      .all()
      .map((row) => [row["session_id"], row["through_sequence"]])
  const repaired = stored()

  database.exec("DELETE FROM session_messages WHERE session_id = 'before' AND seq = 1")
  const pastItsRange = stored()
  database.exec("DELETE FROM session_messages WHERE session_id = 'behind' AND seq = 1")
  expect({ repaired, pastItsRange, reverted: stored() }).toEqual({
    repaired: [
      ["before", 0],
      ["behind", 1]
    ],
    pastItsRange: [
      ["before", 0],
      ["behind", 1]
    ],
    reverted: [["before", 0]]
  })
})
