import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"

import { searchSchemaSection, searchSchemaUpgrades } from "../src/persistence/schema/search.js"

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

it("upgrades version 2 Granite vectors into a serving index without re-embedding", () => {
  withSearch((database) => {
    database.exec(`CREATE TABLE search.wiki_embedding_chunks (
      page_id TEXT NOT NULL,
      page_version TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
      index_version TEXT NOT NULL,
      chunk_text TEXT NOT NULL CHECK(length(chunk_text) > 0),
      embedding BLOB NOT NULL CHECK(typeof(embedding) = 'blob' AND length(embedding) = 1536),
      PRIMARY KEY (page_id, chunk_index)
      )`)
    const insert = database.prepare(`INSERT INTO search.wiki_embedding_chunks
      (page_id, page_version, chunk_index, index_version, chunk_text, embedding)
      VALUES (?, ?, ?, ?, ?, ?)`)
    insert.run("editor", "e1", 0, "granite@v2", "Zed", vector(384))
    insert.run("editor", "e1", 1, "granite@v2", "editor", vector(384))
    insert.run("garden", "g1", 0, "granite@v2", "Tomatoes", vector(384))
    insert.run("stale", "s1", 0, "granite@v1", "old", vector(384))

    for (const statement of searchSchemaUpgrades[2] ?? []) database.exec(statement)

    expect(
      rows(
        database,
        "SELECT index_version, model_id, dimensions, role FROM search.wiki_embedding_indexes"
      )
    ).toEqual([
      {
        index_version: "granite@v2",
        model_id: "ibm-granite/granite-embedding-97m-multilingual-r2",
        dimensions: 384,
        role: "serving"
      }
    ])
    expect(
      rows(
        database,
        "SELECT page_id, page_version FROM search.wiki_embedding_pages ORDER BY page_id"
      )
    ).toEqual([
      { page_id: "editor", page_version: "e1" },
      { page_id: "garden", page_version: "g1" }
    ])
    expect(
      rows(
        database,
        "SELECT page_id, chunk_index, chunk_text FROM search.wiki_embedding_chunks ORDER BY page_id, chunk_index"
      )
    ).toEqual([
      { page_id: "editor", chunk_index: 0, chunk_text: "Zed" },
      { page_id: "editor", chunk_index: 1, chunk_text: "editor" },
      { page_id: "garden", chunk_index: 0, chunk_text: "Tomatoes" }
    ])
    expect(
      rows(database, "SELECT name FROM search.sqlite_schema WHERE type = 'table' ORDER BY name")
    ).toEqual(
      searchSchemaSection.tables
        .filter((table) => table.startsWith("wiki_"))
        .sort()
        .map((name) => ({ name }))
    )
  })
})

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
    expect(() => insert.run("granite@2", vector(768))).toThrow(/dimensions/u)
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
