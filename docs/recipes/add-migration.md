# Add a database migration

Use this when a change adds, changes or removes a table, column, index or trigger.
It is one real change shown file by file: migration 166 added three columns to
`scheduled_tasks` (commit `afe086d`). Copy its shape.

## 1. Write the migration

Take the next number: the last entry of `migrations` in
`apps/server-ts/src/persistence/migrations/index.ts` plus one. The file name is
that number in four digits and the name in snake case.

`apps/server-ts/src/persistence/migrations/0166_automation_failure_streak.ts`:

```ts
import type { Migration } from "./index.js"

export const automationFailureStreak: Migration = {
  version: 166,
  name: "automation_failure_streak",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN failed_runs INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_tasks ADD COLUMN failed_item TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN failed_attempt INTEGER;`)
}
```

`foreignKeys` is `enforced` when the migration adds tables, columns or indexes,
rewrites values, or drops a table nothing references. For a table rebuild, read
the comment on `MigrationForeignKeys` in `index.ts`. A rewrite of many rows is a
backfill in `apps/server-ts/src/persistence/sqlite/backfills/index.ts`, not a
migration.

## 2. Register it

In `apps/server-ts/src/persistence/migrations/index.ts`, add the import after the
last import and the name at the end of `migrations`:

```ts
import { automationFailureStreak } from "./0166_automation_failure_streak.js"
…
  messageAuthors,
  automationFailureStreak
]
```

## 3. Declare the same schema

The schema of a new database is declared in
`apps/server-ts/src/persistence/schema/sections`. Find the section that holds the
table and add the same statements, one string each. In `automation.ts`:

```ts
    "ALTER TABLE scheduled_tasks ADD COLUMN paused_at TEXT",
    "ALTER TABLE scheduled_tasks ADD COLUMN failed_runs INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE scheduled_tasks ADD COLUMN failed_item TEXT",
    "ALTER TABLE scheduled_tasks ADD COLUMN failed_attempt INTEGER",
```

If `apps/server-ts/test/persistence-schema.test.ts` lists the table's columns,
add the new ones there in the same order.

## 4. Pin the SQL

Run the check below once. It fails and prints the hash of your migration's SQL.
Add that line to `apps/server-ts/test/fixtures/migration-sql-pins.ts`:

```ts
  166: "28d44b72b0927fc2a6f55e4e10aef09b08048995548c2bae2f59ef3c48df7b3f",
```

Never change the pin or the file of a migration that is already on `main`. Write
a new migration.

## Check

```bash
cd apps/server-ts && bunx vitest run test/schema-migrations.test.ts test/persistence-schema.test.ts
```

It takes about 10 seconds and must end with:

```
 Test Files  2 passed (2)
```

What each failure means:

- `Migration <name> has version N; expected M`: the number is wrong, or the name
  is not last in `migrations` (step 2).
- `every migration runs the SQL pinned for it`: the pin is missing or old (step 4).
- `the baseline plus every migration builds exactly the schema sections declare`:
  the section and the migration disagree (step 3). The output shows both SQL texts.
