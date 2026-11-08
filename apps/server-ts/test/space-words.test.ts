import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"
import { spaceValue } from "../src/persistence/space-words-released.js"

describe("desk to space conversion", () => {
  it("converts the app's names and keeps prose, desktop and number text exact", () => {
    expect(spaceValue("desk_review")).toBe("space_review")
    expect(spaceValue("desk:961b4d6e")).toBe("space:961b4d6e")
    expect(spaceValue('{"_tag":"Desk"}')).toBe('{"_tag":"Space"}')
    expect(spaceValue("my desk is full")).toBe("my desk is full")
    expect(spaceValue("desktop_app")).toBe("desktop_app")
    expect(spaceValue(42)).toBe(42)
    expect(
      spaceValue(
        '{"actor":{"kind":"desk_review","desk_id":"d1"},"n":12345678901234567890,"note":"a desk"}'
      )
    ).toBe(
      '{"actor":{"kind":"space_review","space_id":"d1"},"n":12345678901234567890,"note":"a desk"}'
    )
    expect(spaceValue('{"arguments":"{\\"desk_id\\":\\"d1\\"}"}')).toBe(
      '{"arguments":"{\\"space_id\\":\\"d1\\"}"}'
    )
    expect(spaceValue("not json { desk_id")).toBe("not json { desk_id")
  })

  it("migration 0141 renames desk tables and converts their rows and references", () => {
    const database = new DatabaseSync(":memory:")
    try {
      for (const statement of baselineStatements) database.exec(statement)
      database.exec("PRAGMA user_version = 1")
      const before = migrations.filter((migration) => migration.version < 141)
      for (const step of pendingMigrationSteps(
        { kind: "pending", from: 1, bridge: undefined },
        before
      ))
        step.run(database)
      const at = "2026-11-08T00:00:00Z"
      database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at)
        VALUES ('d1', 'My desk', 'my desk', '${at}', '${at}')`)
      database.exec(`INSERT INTO sessions
        (session_id, public_ref, started_at, last_activity, session_type, desk_id, metadata)
        VALUES ('s1', 's1', '${at}', '${at}', 'chat', 'd1', '{"origin":{"kind":"desk","desk_id":"d1"}}')`)
      for (const step of pendingMigrationSteps(
        { kind: "pending", from: 140, bridge: undefined },
        migrations
      ))
        step.run(database)
      expect(database.prepare("SELECT space_id, name FROM spaces").all()).toEqual([
        { space_id: "d1", name: "My desk" }
      ])
      expect(database.prepare("SELECT space_id, metadata FROM sessions").all()).toEqual([
        { space_id: "d1", metadata: '{"origin":{"kind":"space","space_id":"d1"}}' }
      ])
      const leftovers = database
        .prepare(
          `SELECT name FROM sqlite_schema
          WHERE replace(replace(sql, 'desktop', ''), 'Desktop', '') LIKE '%desk%'`
        )
        .all()
      expect(leftovers).toEqual([])
    } finally {
      database.close()
    }
  })
})
