import type { TaskContract } from "../work/contract.js"
import type { TaskStateView } from "../work/task-state.js"

interface SpaceReviewTask {
  readonly itemId: string
  readonly historyRevision: string | null
  readonly text: string
  readonly status: string
  readonly owner: string
  readonly blocked: boolean
  readonly waitingOn: string | undefined
  readonly held: boolean
}

export interface SpaceReviewSnapshot {
  readonly spaceId: string
  readonly name: string
  readonly instructions: string | undefined
  readonly pagePath: string | undefined
  readonly inferenceEnabled: boolean
  readonly openTasks: ReadonlyArray<SpaceReviewTask>
}

interface TaskWorkerComment {
  readonly author: string
  readonly body: string
  readonly createdAt: string
}

interface TaskWorkerAttachment {
  readonly attachmentId: number
  readonly name: string
  readonly createdAt: string
}

interface TaskWorkerSpace {
  readonly spaceId: string
  readonly spaceName: string
  readonly spaceInstructions: string | undefined
  readonly pagePath: string | undefined
}

export const TASK_SPEAKS_IN = { chat: "chat", space: "space" } as const
export const SPACE_JOB_PROMPT = {
  spaceReview: "space_review",
  taskExecution: "task_execution"
} as const

export interface TaskWorkerSnapshot {
  readonly itemId: string
  readonly text: string
  readonly body: string | undefined
  readonly state: TaskStateView | undefined
  readonly dueAt: string | undefined
  readonly nextAttemptAt: string | undefined
  readonly blockReason: string | undefined
  readonly status: string
  readonly owner: string
  readonly blocked: boolean
  readonly waitingOn: string | undefined
  readonly updatedAt: string
  readonly space: TaskWorkerSpace | undefined
  readonly speaksIn: (typeof TASK_SPEAKS_IN)[keyof typeof TASK_SPEAKS_IN]
  readonly comments: ReadonlyArray<TaskWorkerComment>
  readonly history: ReadonlyArray<{ readonly at: string; readonly summary: string }>
  readonly saved: ReadonlyArray<TaskWorkerAttachment>
  readonly stalledRuns: number
  readonly openQuestion: { readonly prompt: string; readonly askedAt: string } | undefined
  readonly contract: TaskContract
}

export type SpaceJobPromptContext =
  | {
      readonly kind: typeof SPACE_JOB_PROMPT.spaceReview
      readonly space: SpaceReviewSnapshot | undefined
    }
  | {
      readonly kind: typeof SPACE_JOB_PROMPT.taskExecution
      readonly task: TaskWorkerSnapshot | undefined
    }

export const AUTOMATION_JOB_PROMPT = { text: "text", spaceJob: "space_job" } as const

export type AutomationJobPrompt =
  | {
      readonly kind: typeof AUTOMATION_JOB_PROMPT.text
      readonly text: string
      readonly triggerContext: string | undefined
    }
  | {
      readonly kind: typeof AUTOMATION_JOB_PROMPT.spaceJob
      readonly context: SpaceJobPromptContext
      readonly triggerContext: string | undefined
    }
