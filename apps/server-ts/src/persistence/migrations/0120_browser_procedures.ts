import type { Migration } from "./index.js"
import { browserProceduresStatementsV1 } from "../schema/browser-procedures-released.js"

export const browserProcedures: Migration = {
  version: 120,
  name: "browser_procedures",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of browserProceduresStatementsV1) database.exec(statement)
    database.exec("DROP TABLE browser_replays")
  }
}
