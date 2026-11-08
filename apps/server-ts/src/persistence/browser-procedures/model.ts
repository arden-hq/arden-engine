import { canonicalJson } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"
import { Schema } from "effect"

export const PAGE_TEXT_MAX_CHARS = 16_000
const Text = Schema.String.check(Schema.isMaxLength(16_000))
const ProcedureFieldSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/u)),
  type: Schema.Literals(["string", "number", "boolean"]),
  description: Text,
  required: Schema.Boolean
})
export const procedureFieldsMatch = (
  fields: ReadonlyArray<typeof ProcedureFieldSchema.Type>,
  values: Readonly<Record<string, Schema.Json>>
): boolean =>
  Object.keys(values).every((name) => fields.some((field) => field.name === name)) &&
  fields.every((field) =>
    values[field.name] === undefined ? !field.required : typeof values[field.name] === field.type
  )
export const ProcedureSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  description: Text,
  intent: Text,
  inputs: Schema.Array(ProcedureFieldSchema).check(Schema.isMaxLength(30)),
  outputs: Schema.Array(ProcedureFieldSchema).check(Schema.isMaxLength(30)),
  applicability: Text,
  verification: Text,
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40_000)),
  verify: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  example_input: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
  ).annotate({
    description:
      "Only the observed business INPUT values, keyed directly by declared input name, for example {reference:'alpha'}. Each value is a string, number or boolean matching that input's type. No input/output/result wrapper, output values, tab refs, profile refs or origin."
  }),
  writes: Schema.Boolean
}).check(
  Schema.makeFilter((spec) =>
    procedureFieldsMatch(spec.inputs, spec.example_input)
      ? []
      : [
          {
            path: ["example_input"],
            issue: "must contain exactly the declared required inputs with their declared types"
          }
        ]
  )
)
export type ProcedureSpec = typeof ProcedureSpecSchema.Type
const EvidenceCallSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  args: Schema.Record(Schema.String, Schema.Json),
  result: Schema.Record(Schema.String, Schema.Json),
  changes_state: Schema.Boolean
})
export type ProcedureEvidenceCall = typeof EvidenceCallSchema.Type
const CondensedSchema = Schema.Struct({
  visits: Schema.Int,
  actions: Schema.Int,
  reads: Schema.Int,
  reads_kept: Schema.Int,
  steps_omitted: Schema.Int
})
export type ProcedureEvidenceCondensed = typeof CondensedSchema.Type
export const ProcedureEvidenceSchema = Schema.Struct({
  run_id: Schema.String,
  session_id: Schema.String,
  completed_at: Schema.String,
  calls: Schema.Array(EvidenceCallSchema).check(Schema.isMaxLength(120)),
  condensed: Schema.optionalKey(CondensedSchema)
})
export type ProcedureEvidence = typeof ProcedureEvidenceSchema.Type
export interface StoredProcedure {
  readonly id: string
  readonly origin: string
  readonly profile: string
  readonly revision: number
  readonly status: "candidate" | "accepted" | "suspended"
  readonly enabled: boolean
  readonly spec: ProcedureSpec
  readonly evidence: ReadonlyArray<ProcedureEvidence>
  readonly successes: number
  readonly failures: number
  readonly updatedAt: string
}
export interface ProcedureJob {
  readonly id: string
  readonly runId: string
  readonly attempts: number
}

export const procedureInputHash = (input: Readonly<Record<string, Schema.Json>>): string =>
  sha256Hex(canonicalJson(input))

const LearningMarkSchema = Schema.Struct({
  procedure_learning: Schema.Struct({
    eligible: Schema.Boolean,
    withheld: Schema.optionalKey(Schema.Literal(true))
  })
})
export type CaptureLearning = "safe" | "withheld" | "sensitive" | "unmarked"
export const captureLearning = (data: unknown): CaptureLearning => {
  const mark = Schema.decodeUnknownOption(LearningMarkSchema)(data)
  if (mark._tag === "None") return "unmarked"
  const { eligible, withheld } = mark.value.procedure_learning
  if (eligible) return "safe"
  return withheld === true ? "withheld" : "sensitive"
}
export const learningMark = (
  ...captures: ReadonlyArray<unknown>
): { readonly eligible: boolean; readonly withheld?: true } => {
  const kinds = captures.map(captureLearning)
  if (kinds.every((kind) => kind === "safe")) return { eligible: true }
  return kinds.every((kind) => kind === "safe" || kind === "withheld")
    ? { eligible: false, withheld: true }
    : { eligible: false }
}
const EvidenceScopeSchema = Schema.Struct({
  data: Schema.Struct({
    origin: Schema.optionalKey(Schema.String),
    tab: Schema.Struct({ profile_ref: Schema.String, url: Schema.String })
  })
})
export const procedureEvidenceScope = (
  evidence: ProcedureEvidence
): { readonly origin: string; readonly profile: string } | undefined => {
  const scopes = evidence.calls.flatMap((call) => {
    const decoded = Schema.decodeUnknownOption(EvidenceScopeSchema)(call.result)
    if (decoded._tag === "None" || !URL.canParse(decoded.value.data.tab.url)) return []
    const url = new URL(decoded.value.data.tab.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") return []
    return [{ origin: url.origin, profile: decoded.value.data.tab.profile_ref }]
  })
  const first = scopes[0]
  return first !== undefined &&
    scopes.every((scope) => scope.origin === first.origin && scope.profile === first.profile)
    ? first
    : undefined
}

export const ProcedurePolicySchema = Schema.Struct({
  goal: Schema.String,
  values: Schema.String,
  secrets: Schema.Array(Schema.String),
  maxSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))
})
export type ProcedurePolicy = typeof ProcedurePolicySchema.Type
