import type { RuntimeRunStatus } from "../chat/runtime.js"

export const SESSION_NAME = { unnamed: "unnamed", named: "named" } as const
export const SESSION_SPACE = { none: "none", space: "space" } as const
export const SESSION_MODEL = { inherited: "inherited", pinned: "pinned" } as const
export const SESSION_ORIGIN = {
  ordinary: "ordinary",
  capture: "capture",
  onboarding: "onboarding"
} as const
export const SESSION_PARENT = { none: "none", agent: "agent", chat: "chat" } as const
export const PARENT_MESSAGE = { whole: "whole", message: "message" } as const
export const SESSION_PARENT_STEP = { none: "none", step: "step" } as const
export const SESSION_RUN = { none: "none", active: "active", settled: "settled" } as const
export const SESSION_FORK = { none: "none", fork: "fork" } as const
export const THREAD_SOURCE = { none: "none", thread: "thread", gone: "gone" } as const
export const SESSION_SUMMARY = { none: "none", summary: "summary" } as const
export const AGENT_WORKSPACE = { none: "none", workspace: "workspace" } as const
export const SESSION_ACTIVITY = { idle: "idle", running: "running" } as const
export const ACTIVITY_TEXT = { unstated: "unstated", stated: "stated" } as const
export const FIRST_LINE = { none: "none", line: "line" } as const

export type SessionName =
  | { readonly kind: typeof SESSION_NAME.unnamed }
  | { readonly kind: typeof SESSION_NAME.named; readonly name: string }

export type SessionSpace =
  | { readonly kind: typeof SESSION_SPACE.none }
  | { readonly kind: typeof SESSION_SPACE.space; readonly space_id: string }

export type SessionChatModel =
  | { readonly kind: typeof SESSION_MODEL.inherited }
  | { readonly kind: typeof SESSION_MODEL.pinned; readonly model_id: string }

export type SessionOrigin = (typeof SESSION_ORIGIN)[keyof typeof SESSION_ORIGIN]

export type SessionParentStep =
  | { readonly kind: typeof SESSION_PARENT_STEP.none }
  | { readonly kind: typeof SESSION_PARENT_STEP.step; readonly tool_call_id: string }

export type ParentMessage =
  | { readonly kind: typeof PARENT_MESSAGE.whole }
  | { readonly kind: typeof PARENT_MESSAGE.message; readonly message_id: string }

export type SessionParent =
  | { readonly kind: typeof SESSION_PARENT.none }
  | {
      readonly kind: typeof SESSION_PARENT.agent
      readonly session_id: string
      readonly run_id: string
      readonly tool_call_id: string
      readonly step: SessionParentStep
    }
  | {
      readonly kind: typeof SESSION_PARENT.chat
      readonly session_id: string
      readonly message: ParentMessage
    }

export type SessionRun =
  | { readonly kind: typeof SESSION_RUN.none }
  | {
      readonly kind: typeof SESSION_RUN.active
      readonly run_id: string
      readonly turn_id: string
      readonly status: RuntimeRunStatus
    }
  | {
      readonly kind: typeof SESSION_RUN.settled
      readonly run_id: string
      readonly status: RuntimeRunStatus
    }

export type SessionFork =
  | { readonly kind: typeof SESSION_FORK.none }
  | { readonly kind: typeof SESSION_FORK.fork; readonly at: string; readonly turn_id: string }

export type SessionThreadSource =
  | { readonly kind: typeof THREAD_SOURCE.none }
  | {
      readonly kind: typeof THREAD_SOURCE.thread
      readonly session_id: string
      readonly session_ref: string
    }
  | { readonly kind: typeof THREAD_SOURCE.gone; readonly session_id: string }

export type SessionSummary =
  | { readonly kind: typeof SESSION_SUMMARY.none }
  | { readonly kind: typeof SESSION_SUMMARY.summary; readonly text: string }

export type AgentWorkspace =
  | { readonly kind: typeof AGENT_WORKSPACE.none }
  | { readonly kind: typeof AGENT_WORKSPACE.workspace; readonly path: string }

export type ActivityText =
  | { readonly kind: typeof ACTIVITY_TEXT.unstated }
  | { readonly kind: typeof ACTIVITY_TEXT.stated; readonly text: string }

export type SessionActivity =
  | { readonly kind: typeof SESSION_ACTIVITY.idle }
  | {
      readonly kind: typeof SESSION_ACTIVITY.running
      readonly run_id: string
      readonly sequence: number
      readonly purpose: ActivityText
      readonly run_purpose: ActivityText
      readonly operations: ReadonlyArray<{ readonly id: string; readonly text: ActivityText }>
    }

export type FirstLine =
  | { readonly kind: typeof FIRST_LINE.none }
  | { readonly kind: typeof FIRST_LINE.line; readonly text: string }

export const nameText = (name: SessionName): string | null =>
  name.kind === SESSION_NAME.named ? name.name : null

export const spaceIdOf = (space: SessionSpace): string | null =>
  space.kind === SESSION_SPACE.space ? space.space_id : null

export const modelIdOf = (model: SessionChatModel): string | null =>
  model.kind === SESSION_MODEL.pinned ? model.model_id : null

export const runIsActive = (run: SessionRun): boolean => run.kind === SESSION_RUN.active

export const activeRunId = (run: SessionRun): string | null =>
  run.kind === SESSION_RUN.active ? run.run_id : null
