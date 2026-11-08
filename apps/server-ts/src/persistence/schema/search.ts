import type { VersionedSchemaSection } from "./section.js"

const wikiEmbeddingStatements = [
  `CREATE TABLE search.wiki_embedding_indexes (
      index_version TEXT PRIMARY KEY CHECK(length(index_version) > 0),
      model_id TEXT NOT NULL CHECK(length(model_id) > 0),
      dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 16384),
      role TEXT NOT NULL UNIQUE CHECK(role IN ('serving', 'building')),
      started_at TEXT NOT NULL
      )`,
  `CREATE TABLE search.wiki_embedding_pages (
      index_version TEXT NOT NULL
        REFERENCES wiki_embedding_indexes(index_version) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      page_version TEXT NOT NULL,
      PRIMARY KEY (index_version, page_id)
      )`,
  `CREATE TABLE search.wiki_embedding_chunks (
      index_version TEXT NOT NULL,
      page_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
      chunk_text TEXT NOT NULL CHECK(length(chunk_text) > 0),
      embedding BLOB NOT NULL CHECK(typeof(embedding) = 'blob' AND length(embedding) > 0),
      PRIMARY KEY (index_version, page_id, chunk_index),
      FOREIGN KEY (index_version, page_id)
        REFERENCES wiki_embedding_pages(index_version, page_id) ON DELETE CASCADE
      )`,
  `CREATE TRIGGER search.wiki_embedding_chunks_dimensions
      BEFORE INSERT ON wiki_embedding_chunks
      WHEN length(NEW.embedding) IS NOT (
        SELECT 4 * dimensions FROM wiki_embedding_indexes
        WHERE index_version = NEW.index_version
      )
      BEGIN SELECT RAISE(ABORT, 'embedding length does not match its index dimensions'); END`
] as const

export const searchSchemaSection = {
  name: "search",
  version: 3,
  tables: [
    "session_messages_fts",
    "session_messages_fts_config",
    "session_messages_fts_content",
    "session_messages_fts_data",
    "session_messages_fts_docsize",
    "session_messages_fts_idx",
    "wiki_embedding_indexes",
    "wiki_embedding_pages",
    "wiki_embedding_chunks",
    "transcript_cursor"
  ],
  indexes: [],
  triggers: ["wiki_embedding_chunks_dimensions"],
  statements: [
    `CREATE VIRTUAL TABLE search.session_messages_fts USING fts5(
      search_text, tokenize='unicode61 remove_diacritics 2'
      )`,
    ...wikiEmbeddingStatements,
    `CREATE TABLE search.transcript_cursor (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
       applied_sequence INTEGER NOT NULL CHECK(applied_sequence >= 0),
       source_id TEXT NOT NULL CHECK(length(source_id) = 32)
      )`
  ]
} as const satisfies VersionedSchemaSection

export const searchSchemaUpgrades: Readonly<Record<number, ReadonlyArray<string>>> = {
  2: [
    "ALTER TABLE search.wiki_embedding_chunks RENAME TO wiki_embedding_chunks_v2",
    ...wikiEmbeddingStatements,
    `INSERT INTO search.wiki_embedding_indexes (index_version, model_id, dimensions, role, started_at)
      SELECT index_version, 'ibm-granite/granite-embedding-97m-multilingual-r2', 384, 'serving',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM search.wiki_embedding_chunks_v2
      GROUP BY index_version
      ORDER BY count(*) DESC, index_version
      LIMIT 1`,
    `INSERT INTO search.wiki_embedding_pages (index_version, page_id, page_version)
      SELECT old.index_version, old.page_id, max(old.page_version)
      FROM search.wiki_embedding_chunks_v2 AS old
      JOIN search.wiki_embedding_indexes AS idx ON idx.index_version = old.index_version
      GROUP BY old.index_version, old.page_id`,
    `INSERT INTO search.wiki_embedding_chunks
        (index_version, page_id, chunk_index, chunk_text, embedding)
      SELECT old.index_version, old.page_id, old.chunk_index, old.chunk_text, old.embedding
      FROM search.wiki_embedding_chunks_v2 AS old
      JOIN search.wiki_embedding_pages AS page
        ON page.index_version = old.index_version
        AND page.page_id = old.page_id
        AND page.page_version = old.page_version`,
    "DROP TABLE search.wiki_embedding_chunks_v2"
  ]
}
