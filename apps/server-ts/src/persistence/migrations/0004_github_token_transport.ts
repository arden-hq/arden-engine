import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const githubTokenTransport: Migration = {
  version: 4,
  name: "github_token_transport",
  up: (database: DatabaseSync) => {
    database.exec(`
      UPDATE mcp_servers
      SET transport_json = json_set(transport_json, '$.auth', 'none', '$.headerKeys', json('[]'))
      WHERE preset_id = 'github'
        AND json_extract(transport_json, '$.type') = 'http'
        AND (
          json_extract(transport_json, '$.auth') IS NOT 'none'
          OR json_array_length(transport_json, '$.headerKeys') > 0
        )
    `)
  }
}
