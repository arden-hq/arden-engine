import { Schema } from "effect"

export const BROWSER_PROCEDURE_STATUS = {
  candidate: "candidate",
  accepted: "accepted",
  suspended: "suspended",
  disabled: "disabled"
} as const

export type BrowserProcedureStatus =
  (typeof BROWSER_PROCEDURE_STATUS)[keyof typeof BROWSER_PROCEDURE_STATUS]

export const BROWSER_PROCEDURE_JOB_STATUS = {
  pending: "pending",
  running: "running",
  failed: "failed"
} as const

export type BrowserProcedureJobStatus =
  (typeof BROWSER_PROCEDURE_JOB_STATUS)[keyof typeof BROWSER_PROCEDURE_JOB_STATUS]

export const BrowserProcedureSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  origin: Schema.String,
  profile_ref: Schema.String,
  status: Schema.Literals(Object.values(BROWSER_PROCEDURE_STATUS)),
  revision: Schema.Int,
  success_count: Schema.Int,
  failure_count: Schema.Int,
  updated_at: Schema.String
})
export const BrowserProcedureDetailSchema = Schema.Struct({
  ...BrowserProcedureSummarySchema.fields,
  code: Schema.String,
  input_contract: Schema.String,
  output_contract: Schema.String,
  applicability: Schema.String,
  verification: Schema.String,
  evidence_count: Schema.Int
})
export const BrowserProcedureJobSchema = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    status: Schema.Union([
      Schema.Literal(BROWSER_PROCEDURE_JOB_STATUS.pending),
      Schema.Literal(BROWSER_PROCEDURE_JOB_STATUS.running)
    ])
  }),
  Schema.Struct({
    id: Schema.String,
    status: Schema.Literal(BROWSER_PROCEDURE_JOB_STATUS.failed),
    error: Schema.String
  })
])
export const BrowserProcedureListSchema = Schema.Struct({
  enabled: Schema.Boolean,
  procedures: Schema.Array(BrowserProcedureSummarySchema),
  jobs: Schema.Array(BrowserProcedureJobSchema)
})
export const BrowserProcedureEnabledSchema = Schema.Struct({ enabled: Schema.Boolean })
export const BrowserProcedureMutationSchema = Schema.Struct({ ok: Schema.Literal(true) })
