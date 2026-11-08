import { Schema } from "effect"

export const JobPurposeSchema = Schema.Literals([
  "user_automation",
  "space_review",
  "task_execution",
  "system"
])
export type JobPurpose = typeof JobPurposeSchema.Type

export type JobClassification =
  | {
      readonly purpose: "user_automation"
      readonly owner_space_id: null
      readonly owner_task_id: null
    }
  | {
      readonly purpose: "space_review"
      readonly owner_space_id: string
      readonly owner_task_id: null
    }
  | {
      readonly purpose: "task_execution"
      readonly owner_space_id: string | null
      readonly owner_task_id: string
    }
  | { readonly purpose: "system"; readonly owner_space_id: null; readonly owner_task_id: null }

export const isUserAutomationPurpose = <Purpose extends string | null | undefined>(
  purpose: Purpose
): purpose is Extract<Purpose, "user_automation"> => purpose === "user_automation"

export const isSpaceWorkJob = (job: { readonly purpose: JobPurpose }): boolean =>
  job.purpose === "space_review" || job.purpose === "task_execution"
