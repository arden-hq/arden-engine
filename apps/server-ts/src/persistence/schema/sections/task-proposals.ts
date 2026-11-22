import type { OperationalSchemaSection } from "../section.js"
import { TASK_PROPOSALS_TABLE } from "../../migrations/0185_items_unrouted.js"

export const taskProposalsSchemaSection = {
  name: "task-proposals",
  storageDomain: "work",
  tables: ["task_proposals"],
  indexes: [
    "idx_task_proposals_space_status",
    "idx_task_proposals_place_status",
    "idx_task_proposals_chat_status",
    "idx_task_proposals_item_id",
    "idx_task_proposals_source_session_id"
  ],
  triggers: [],
  statements: [
    TASK_PROPOSALS_TABLE,
    `CREATE INDEX idx_task_proposals_space_status
      ON task_proposals(space_id, status, updated_at DESC, proposal_id)`,
    `CREATE INDEX idx_task_proposals_place_status
      ON task_proposals(place, status, seq)`,
    `CREATE INDEX idx_task_proposals_chat_status
      ON task_proposals(chat_session_id, status)`,
    "CREATE INDEX idx_task_proposals_item_id ON task_proposals(item_id)",
    "CREATE INDEX idx_task_proposals_source_session_id ON task_proposals(source_session_id)"
  ]
} as const satisfies OperationalSchemaSection
