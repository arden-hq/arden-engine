import { Schema } from "effect"

export const BrowserProcedureSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  origin: Schema.String,
  profile_ref: Schema.String,
  status: Schema.Literals(["candidate", "accepted", "suspended", "disabled"]),
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
export const BrowserProcedureListSchema = Schema.Struct({
  enabled: Schema.Boolean,
  procedures: Schema.Array(BrowserProcedureSummarySchema),
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["pending", "running", "failed"]),
      error: Schema.optionalKey(Schema.String)
    })
  )
})
export const BrowserProcedureEnabledSchema = Schema.Struct({ enabled: Schema.Boolean })
export const BrowserProcedureMutationSchema = Schema.Struct({ ok: Schema.Literal(true) })
