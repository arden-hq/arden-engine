import { Schema } from "effect"
import { AutomationId } from "./automations/model.js"

export const spaceJobId = (spaceId: string): string => `space:${spaceId}`

export const taskJobId = (itemId: string): string => `task:${itemId}`

export const taskOfJob = (automationId: string): string | undefined =>
  automationId.startsWith("task:") ? automationId.slice("task:".length) : undefined

export const spaceOfJob = (automationId: string): string | undefined =>
  automationId.startsWith("space:") ? automationId.slice("space:".length) : undefined

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
