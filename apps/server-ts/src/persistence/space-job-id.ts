import { Schema } from "effect"
import { AutomationId } from "./automations/model.js"

export const spaceJobId = (spaceId: string): string => `space:${spaceId}`

export const taskJobId = (itemId: string): string => `task:${itemId}`

export const TaskItemId = Schema.NonEmptyString.pipe(Schema.brand("TaskItemId"))
export type TaskItemId = typeof TaskItemId.Type

export const SpaceId = Schema.NonEmptyString.pipe(Schema.brand("SpaceId"))
export type SpaceId = typeof SpaceId.Type

export const JOB_SUBJECT_KIND = {
  task: "task",
  spaceReview: "space_review",
  automation: "automation"
} as const
export const TaskSubjectSchema = Schema.Struct({
  kind: Schema.Literal(JOB_SUBJECT_KIND.task),
  itemId: TaskItemId
})

export const SpaceReviewSubjectSchema = Schema.Struct({
  kind: Schema.Literal(JOB_SUBJECT_KIND.spaceReview),
  spaceId: SpaceId
})

export const AutomationSubjectSchema = Schema.Struct({
  kind: Schema.Literal(JOB_SUBJECT_KIND.automation),
  automationId: AutomationId
})
