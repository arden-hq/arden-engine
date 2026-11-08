import type { Migration } from "./index.js"

export const mcpStdioCwd: Migration = {
  version: 14,
  name: "mcp_stdio_cwd",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`
      UPDATE mcp_servers
      SET transport_json = json_set(transport_json, '$.cwd', json('null'))
      WHERE json_extract(transport_json, '$.type') = 'stdio'
        AND json_type(transport_json, '$.cwd') IS NULL
    `)
  }
}
