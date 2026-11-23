import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"

import { searchSchemaSection } from "../src/persistence/schema/search.js"

const vector = (dimensions: number) => new Uint8Array(dimensions * Float32Array.BYTES_PER_ELEMENT)

const withSearch = (run: (database: DatabaseSync) => void): void => {
  const database = new DatabaseSync(":memory:")
  try {
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("ATTACH DATABASE ':memory:' AS search")
    run(database)
  } finally {
    database.close()
  }
}

const rows = (database: DatabaseSync, sql: string) =>
  database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }))

it("holds each index to its own dimensions and deletes an index with its vectors", () => {
  withSearch((database) => {
    for (const statement of searchSchemaSection.statements) database.exec(statement)
    database.exec(`INSERT INTO search.wiki_embedding_indexes
      (index_version, model_id, dimensions, role, started_at) VALUES
      ('granite@2', 'granite', 384, 'serving', 'now'),
      ('gemma@1', 'gemma', 768, 'building', 'now')`)
    database.exec(`INSERT INTO search.wiki_embedding_pages (index_version, page_id, page_version)
      VALUES ('granite@2', 'editor', 'e1'), ('gemma@1', 'editor', 'e1')`)
    const insert = database.prepare(`INSERT INTO search.wiki_embedding_chunks
      (index_version, page_id, chunk_index, chunk_text, embedding) VALUES (?, 'editor', 0, 'Zed', ?)`)
    insert.run("granite@2", vector(384))
    insert.run("gemma@1", vector(768))
    expect(() => insert.run("granite@2", vector(768))).toThrow()
    expect(() =>
      database.exec(`INSERT INTO search.wiki_embedding_indexes
        (index_version, model_id, dimensions, role, started_at)
        VALUES ('nomic@1', 'nomic', 768, 'building', 'now')`)
    ).toThrow()

    database.exec("DELETE FROM search.wiki_embedding_indexes WHERE index_version = 'granite@2'")
    expect(rows(database, "SELECT index_version FROM search.wiki_embedding_chunks")).toEqual([
      { index_version: "gemma@1" }
    ])
    expect(rows(database, "SELECT index_version FROM search.wiki_embedding_pages")).toEqual([
      { index_version: "gemma@1" }
    ])
  })
})
