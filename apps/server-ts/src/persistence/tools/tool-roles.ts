export const CODE_MODE_TOOL = "code_mode"
export const WORKFLOW_RETRY_TOOL = "workflow_retry"
export const WORKFLOW_CANCEL_TOOL = "workflow_cancel"
export const SPAWN_AGENT_TOOL = "spawn_agent"
export const AGENT_MESSAGE_TOOL = "agent_message"
export const BROWSER_TASK_TOOL = "browser_task"
export const BROWSER_PERMISSION_TOOL = "browser_permission"
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

export type NestedCallMarker = (typeof NESTED_CALL_MARKERS)[keyof typeof NESTED_CALL_MARKERS]

export const DETACHED_WORKFLOW_OWNER_TOOLS = [
  CODE_MODE_TOOL,
  RETIRED_DYNAMIC_WORKFLOW_TOOL,
  WORKFLOW_RETRY_TOOL
] as const

export const REPLAYABLE_CONTROL_TOOLS = [
  ...DETACHED_WORKFLOW_OWNER_TOOLS,
  WORKFLOW_CANCEL_TOOL
] as const

export const NESTING = {
  code: "code",
  task: "task",
  computer: "computer",
  workflow: "workflow",
  approved: "approved"
} as const

export type NestingKind = (typeof NESTING)[keyof typeof NESTING]

export const SCRIPT_NESTINGS: ReadonlyArray<NestingKind> = [NESTING.code, NESTING.workflow]

type ToolCallNesting =
  | { readonly kind: Exclude<NestingKind, typeof NESTING.workflow> }
  | {
      readonly kind: typeof NESTING.workflow
      readonly agentKey: string
      readonly launch: number
    }

export interface CallParent {
  readonly toolCallId: string
  readonly nesting: ToolCallNesting
}

const NESTED_CALL_NESTING = {
  [CODE_MODE_TOOL]: NESTING.code,
  [BROWSER_TASK_TOOL]: NESTING.task,
  [COMPUTER_TOOL]: NESTING.computer
} as const

export const nestedCallNesting = (toolName: string): NestingKind | undefined =>
  Object.entries(NESTED_CALL_NESTING).find(([name]) => name === toolName)?.[1]
