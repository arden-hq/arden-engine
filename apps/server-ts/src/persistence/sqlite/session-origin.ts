import { SESSION_PARENT_STEP, type SessionParentStep } from "@arden-hq/protocol/sessions"

export const sessionOriginQuery = `
  CASE
    WHEN json_extract(s.metadata, '$.capture.at') IS NOT NULL THEN 'capture'
    WHEN json_extract(s.metadata, '$.onboarding.at') IS NOT NULL THEN 'onboarding'
  END
`

export const sessionOriginColumns = `${sessionOriginQuery} AS origin, (
  SELECT spawn.parent_tool_call_id FROM tool_calls AS spawn
  WHERE spawn.run_id = s.parent_run_id AND spawn.tool_call_id = s.parent_tool_call_id
) AS parent_step_tool_call_id`

export interface ParentStepRow {
  readonly parent_tool_call_id: string | null
  readonly parent_step_tool_call_id: string | null
}

export const sessionParentStep = (row: ParentStepRow): SessionParentStep =>
  row.parent_step_tool_call_id === null
    ? { kind: SESSION_PARENT_STEP.none }
    : { kind: SESSION_PARENT_STEP.step, tool_call_id: row.parent_step_tool_call_id }
