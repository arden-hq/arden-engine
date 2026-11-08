import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE desks
    SET mark = json_remove(
      json_set(
        mark,
        '$.colour', CASE WHEN json_extract(mark, '$.colour') IN ('white', 'black') THEN 'mono' ELSE json_extract(mark, '$.colour') END,
        '$.medium', CASE WHEN json_extract(mark, '$.medium') = 'ink' THEN 'pool' ELSE json_extract(mark, '$.medium') END
      ),
      '$.swirl'
    )
    WHERE mark IS NOT NULL
      AND (json_extract(mark, '$.colour') IN ('white', 'black')
        OR json_extract(mark, '$.medium') = 'ink'
        OR json_type(mark, '$.swirl') IS NOT NULL)`)
}

export const spaceMarkMono: Migration = {
  version: 135,
  name: "space_mark_mono",
  foreignKeys: { kind: "enforced" },
  up
}
