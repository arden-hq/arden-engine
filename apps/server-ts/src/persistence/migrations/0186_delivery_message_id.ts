import type { Migration } from "./index.js"

export const DELIVERY_MESSAGE_ID_COLUMN = `ALTER TABLE automation_deliveries ADD COLUMN
      message_id TEXT GENERATED ALWAYS AS ('arrival:' || delivery_id) VIRTUAL`

export const DELIVERY_MESSAGE_INDEX = `CREATE INDEX idx_automation_deliveries_message
      ON automation_deliveries(message_id)`

export const deliveryMessageId: Migration = {
  version: 186,
  name: "delivery_message_id",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(DELIVERY_MESSAGE_ID_COLUMN)
    database.exec(DELIVERY_MESSAGE_INDEX)
  }
}
