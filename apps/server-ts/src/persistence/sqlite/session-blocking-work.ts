import { SqlClient } from "effect/unstable/sql"
import { activeRunStatusList, liveToolStatusList, unresolvedToolStatusList } from "./status-sets.js"

export const activeSessionRunPredicate = (sql: SqlClient.SqlClient) =>
  sql`EXISTS (
    SELECT 1 FROM chat_runs AS run
    WHERE run.session_id = s.session_id
      AND run.status IN ${activeRunStatusList}
  )`

export const activeSessionExternalWorkPredicate = (sql: SqlClient.SqlClient) =>
  sql`(
    EXISTS (
      SELECT 1 FROM tool_calls AS tool_call
      WHERE tool_call.session_id = s.session_id
        AND tool_call.status IN ${unresolvedToolStatusList}
        AND (
          tool_call.status IN ${liveToolStatusList}
          OR (tool_call.status = 'uncertain' AND tool_call.changes_state = 1)
        )
        AND EXISTS (
          SELECT 1 FROM chat_runs AS tool_run
          WHERE tool_run.run_id = tool_call.run_id
            AND tool_run.status IN ${activeRunStatusList}
        )
    ) OR EXISTS (
      SELECT 1 FROM code_mode_scripts AS script
      WHERE script.origin_session_ref = s.public_ref
        AND script.status = 'running'
    )
  )`

export const sessionBlockingWorkPredicate = (sql: SqlClient.SqlClient) =>
  sql`(
    ${activeSessionRunPredicate(sql)} OR ${activeSessionExternalWorkPredicate(sql)}
  )`
