import type { Migration } from "./index.js"

export const forwardedUserMessages: Migration = {
  version: 82,
  name: "forwarded_user_messages",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    const deliveries = database
      .prepare(`SELECT delivery.delivery_id,
        json_extract(delivery.payload, '$.sessionId') AS target_id,
        json_extract(delivery.payload, '$.forwarded.sessionId') AS source_id,
        json_extract(delivery.payload, '$.forwarded.messageId') AS source_message_id,
        COALESCE(source.public_ref, json_extract(message.message_json, '$.interaction.from.id')) AS source_ref
      FROM automation_deliveries AS delivery
      JOIN session_messages AS message
        ON message.session_id = json_extract(delivery.payload, '$.sessionId')
        AND message.client_id = 'arrival:' || delivery.delivery_id AND message.role = 'user'
      LEFT JOIN sessions AS source ON source.session_id = json_extract(delivery.payload, '$.forwarded.sessionId')
      WHERE json_extract(delivery.payload, '$.kind') = 'thread'
        AND json_extract(delivery.payload, '$.forwarded.messageId') IS NOT NULL`)
      .all()
    const transcript = database.prepare(`UPDATE session_messages
      SET message_json = json_set(message_json, '$.forwarded_from', json(?))
      WHERE session_id = ? AND client_id = ? AND role = 'user'
        AND json_extract(message_json, '$.forwarded_from') IS NULL`)
    const receipt = database.prepare(`UPDATE chat_idempotency_keys
      SET message_json = json_set(message_json, '$.forwarded_from', json(?))
      WHERE session_id = ? AND client_id = ? AND message_json IS NOT NULL
        AND json_extract(message_json, '$.forwarded_from') IS NULL`)
    const projection = database.prepare(`UPDATE sessions SET messages = (
      SELECT json_group_array(json(CASE
        WHEN json_extract(value, '$.client_id') = ? AND json_extract(value, '$.forwarded_from') IS NULL
        THEN json_set(value, '$.forwarded_from', json(?)) ELSE value END) ORDER BY key)
      FROM json_each(messages))
      WHERE session_id = ? AND messages IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(messages)
          WHERE json_extract(value, '$.client_id') = ? AND json_extract(value, '$.forwarded_from') IS NULL)`)
    for (const row of deliveries) {
      if (row.source_ref === null || row.source_id === null) continue
      const source = JSON.stringify({
        session_id: String(row.source_id),
        session_ref: String(row.source_ref),
        message_id: String(row.source_message_id)
      })
      const target = String(row.target_id)
      const client = `arrival:${String(row.delivery_id)}`
      transcript.run(source, target, client)
      receipt.run(source, target, client)
      projection.run(client, source, target, client)
    }
  }
}
