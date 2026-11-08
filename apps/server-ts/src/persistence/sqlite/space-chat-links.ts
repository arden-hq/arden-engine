import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { openProposalStatusList } from "./status-sets.js"

export const pruneChatLinks = (sql: SqlClient.SqlClient, spaceId: string) =>
  sql`DELETE FROM space_chat_links WHERE space_id = ${spaceId}
    AND (NOT EXISTS (SELECT 1 FROM task_proposals
        WHERE space_id = ${spaceId} AND status IN ${openProposalStatusList})
      OR session_id IN (SELECT session_id FROM sessions WHERE space_id = ${spaceId}))`.pipe(
    Effect.asVoid
  )
