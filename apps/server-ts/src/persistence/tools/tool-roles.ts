export const CODE_MODE_TOOL = "code_mode"
export const WORKFLOW_RETRY_TOOL = "workflow_retry"
export const WORKFLOW_CANCEL_TOOL = "workflow_cancel"
export const SPAWN_AGENT_TOOL = "spawn_agent"
export const BROWSER_TASK_TOOL = "browser_task"
export const COMPUTER_TOOL = "computer_repl"

const RETIRED_DYNAMIC_WORKFLOW_TOOL = "dynamic_workflow"

export const ROLE_TOOLS = [
  CODE_MODE_TOOL,
  WORKFLOW_RETRY_TOOL,
  WORKFLOW_CANCEL_TOOL,
  SPAWN_AGENT_TOOL,
  BROWSER_TASK_TOOL,
  COMPUTER_TOOL
] as const

export const NESTED_CALL_MARKERS = {
  [CODE_MODE_TOOL]: ":code:",
  [BROWSER_TASK_TOOL]: ":task:",
  [COMPUTER_TOOL]: ":computer:"
} as const

export const nestedCallMarker = (toolName: string): string | undefined =>
  Object.entries(NESTED_CALL_MARKERS).find(([name]) => name === toolName)?.[1]

export const DETACHED_WORKFLOW_OWNER_TOOLS = [
  CODE_MODE_TOOL,
  RETIRED_DYNAMIC_WORKFLOW_TOOL,
  WORKFLOW_RETRY_TOOL
] as const

export const REPLAYABLE_CONTROL_TOOLS = [
  ...DETACHED_WORKFLOW_OWNER_TOOLS,
  WORKFLOW_CANCEL_TOOL
] as const
