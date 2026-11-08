import { Schema } from "effect"

const LineText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))

export const ContractLineInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("rule"), text: LineText }),
  Schema.Struct({ kind: Schema.Literal("criterion"), text: LineText }),
  Schema.Struct({
    kind: Schema.Literal("decision"),
    text: LineText,
    rejected: Schema.optionalKey(LineText)
  })
])
export type ContractLineInput = typeof ContractLineInputSchema.Type

export const ContractChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("add"),
    line: ContractLineInputSchema,
    replaces: Schema.optionalKey(Schema.Int)
  }),
  Schema.Struct({ kind: Schema.Literal("retire"), line_id: Schema.Int })
])
export type ContractChange = typeof ContractChangeSchema.Type

export const CONTRACT_LINE_LIMIT = 30

export const CRITERION_EVIDENCE_LIMIT = 2

interface ContractLineBase {
  readonly lineId: number
  readonly text: string
  readonly sourceMessageId: string
}

const RecordedEvidenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool_call"),
    tool_call_id: Schema.String,
    tool_name: Schema.String,
    exit_code: Schema.optionalKey(Schema.Int)
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    size: Schema.Int,
    modified_at: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachment_id: Schema.Int,
    name: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    tool_call_id: Schema.String
  })
])
export type RecordedEvidence = typeof RecordedEvidenceSchema.Type

export const CriterionEvidenceSchema = Schema.Struct({
  evidence: RecordedEvidenceSchema,
  recorded_at: Schema.String
})
export type CriterionEvidence = typeof CriterionEvidenceSchema.Type

export type ContractLine =
  | (ContractLineBase & { readonly kind: "rule" })
  | (ContractLineBase & {
      readonly kind: "criterion"
      readonly evidence: ReadonlyArray<CriterionEvidence>
    })
  | (ContractLineBase & { readonly kind: "decision"; readonly rejected: string | undefined })

interface PendingContractChange {
  readonly questionId: string
  readonly change: ContractChange
}

export interface TaskContract {
  readonly lines: ReadonlyArray<ContractLine>
  readonly pending: ReadonlyArray<PendingContractChange>
}

export interface ContractProposalRecord {
  readonly itemId: string
  readonly change: ContractChange
}

export const EvidenceInputSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool_call").annotate({
      description:
        "A tool call of this Task's runs, by its tool_call_id: its recorded result must have succeeded. A command (exec_command, or write_stdin once it exited) counts only with exit code 0."
    }),
    tool_call_id: Schema.NonEmptyString.check(Schema.isMaxLength(256))
  }),
  Schema.Struct({
    kind: Schema.Literal("file").annotate({ description: "A file that exists now." }),
    path: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
      description: "Absolute path."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment").annotate({
      description: "A result saved in this Task (task_save_result)."
    }),
    attachment_id: Schema.Int.check(Schema.isGreaterThan(0))
  }),
  Schema.Struct({
    kind: Schema.Literal("url").annotate({
      description: "A link one of this Task's runs fetched with web_fetch."
    }),
    url: Schema.NonEmptyString.check(Schema.isMaxLength(4_096))
  })
])
export type EvidenceInput = typeof EvidenceInputSchema.Type

export interface CriterionMet {
  readonly lineId: number
  readonly evidence: RecordedEvidence
  readonly unmet: number
}

export const evidenceWords = (evidence: RecordedEvidence): string => {
  switch (evidence.kind) {
    case "tool_call":
      return evidence.exit_code === undefined
        ? `${evidence.tool_name} call ${evidence.tool_call_id}`
        : `${evidence.tool_name} call ${evidence.tool_call_id}, exit code ${evidence.exit_code}`
    case "file":
      return `file ${evidence.path} (${evidence.size} bytes, modified ${evidence.modified_at})`
    case "attachment":
      return `saved result ${JSON.stringify(evidence.name)} (attachment ID ${evidence.attachment_id})`
    case "url":
      return `${evidence.url}, fetched by call ${evidence.tool_call_id}`
  }
}
