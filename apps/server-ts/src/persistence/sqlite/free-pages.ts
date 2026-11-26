import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import { runIsActive } from "./background-pause.js"
import type { Writer } from "./deps.js"
import { StorageSessionStoreError, type StorageSessionStore } from "../storage/session-store.js"

const PageCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const FreePagesRow = Schema.Struct({ free: PageCount, page_size: PageCount })
const FreelistRow = Schema.Struct({ freelist_count: PageCount })

const failed = (message: string) => (cause: unknown) =>
  new StorageSessionStoreError({ operation: "compact", reason: "storage", message, cause })

const freelistCount = (sql: SqlClient.SqlClient) =>
  sql`PRAGMA freelist_count`.pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(FreelistRow)(rows[0])),
    Effect.map((row) => row.freelist_count)
  )

export const makeFreePages = ({
  writer
}: {
  readonly writer: Writer
}): Pick<
  StorageSessionStore["Service"],
  "freePages" | "releaseFreePages" | "checkpoint" | "foregroundWork"
> => ({
  freePages: () =>
    writer.reader`SELECT freelist_count AS free, page_size FROM pragma_freelist_count, pragma_page_size`.pipe(
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(FreePagesRow)(rows[0])),
      Effect.map((row) => ({ free: row.free, pageSize: row.page_size })),
      Effect.mapError(failed("Could not inspect reusable database pages"))
    ),
  releaseFreePages: ({ pages, reservePages }) =>
    writer.run(
      Effect.gen(function* () {
        const before = yield* freelistCount(writer.sql)
        const batch = Math.min(pages, before - reservePages)
        if (batch <= 0) return { released: 0, free: before }
        yield* writer.sql.unsafe(`PRAGMA incremental_vacuum(${batch})`)
        const after = yield* freelistCount(writer.sql)
        return { released: before - after, free: after }
      }).pipe(Effect.mapError(failed("Could not release reusable database pages")))
    ),
  checkpoint: (mode) =>
    writer
      .run(
        writer.sql.unsafe(`PRAGMA wal_checkpoint(${mode === "passive" ? "PASSIVE" : "TRUNCATE"})`)
      )
      .pipe(Effect.asVoid, Effect.mapError(failed("Could not checkpoint the database"))),
  foregroundWork: () =>
    writer.waiting.pipe(
      Effect.flatMap((waiting) =>
        waiting > 0 ? Effect.succeed(true) : runIsActive(writer.reader)
      ),
      Effect.mapError(failed("Could not check for active runs"))
    )
})
