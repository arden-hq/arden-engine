import { Schema } from "effect"
import { AutomationId } from "./automations/model.js"

export const spaceJobId = (spaceId: string): string => `space:${spaceId}`

export const taskJobId = (itemId: string): string => `task:${itemId}`

export const TaskItemId = Schema.NonEmptyString.pipe(Schema.brand("TaskItemId"))
export type TaskItemId = typeof TaskItemId.Type

export const SpaceId = Schema.NonEmptyString.pipe(Schema.brand("SpaceId"))
export type SpaceId = typeof SpaceId.Type

export const TaskSubjectSchema = Schema.Struct({
  kind: Schema.Literal("task"),
  itemId: TaskItemId
})

export const SpaceReviewSubjectSchema = Schema.Struct({
  kind: Schema.Literal("space_review"),
  spaceId: SpaceId
})

export const AutomationSubjectSchema = Schema.Struct({
  kind: Schema.Literal("automation"),
  automationId: AutomationId
})
