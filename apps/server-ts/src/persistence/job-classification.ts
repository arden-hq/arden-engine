import { Schema } from "effect"

export const JOB_PURPOSE = {
  userAutomation: "user_automation",
  spaceReview: "space_review",
  taskExecution: "task_execution",
  system: "system"
} as const

export type JobPurpose = (typeof JOB_PURPOSE)[keyof typeof JOB_PURPOSE]

export const JobPurposeSchema = Schema.Literals(Object.values(JOB_PURPOSE))

export type JobClassification =
  | {
      readonly purpose: typeof JOB_PURPOSE.userAutomation
      readonly owner_space_id: null
      readonly owner_task_id: null
    }
  | {
      readonly purpose: typeof JOB_PURPOSE.spaceReview
      readonly owner_space_id: string
      readonly owner_task_id: null
    }
  | {
      readonly purpose: typeof JOB_PURPOSE.taskExecution
      readonly owner_space_id: string | null
      readonly owner_task_id: string
    }
  | {
      readonly purpose: typeof JOB_PURPOSE.system
      readonly owner_space_id: null
      readonly owner_task_id: null
    }

export const isUserAutomationPurpose = <Purpose extends string | null | undefined>(
  purpose: Purpose
): purpose is Extract<Purpose, typeof JOB_PURPOSE.userAutomation> =>
  purpose === JOB_PURPOSE.userAutomation

const spaceWorkPurposes: ReadonlySet<JobPurpose> = new Set([
  JOB_PURPOSE.spaceReview,
  JOB_PURPOSE.taskExecution
])

export const isSpaceWorkJob = (job: { readonly purpose: JobPurpose }): boolean =>
  spaceWorkPurposes.has(job.purpose)
