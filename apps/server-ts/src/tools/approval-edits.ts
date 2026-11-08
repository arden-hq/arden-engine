import {
  ToolExecutionError,
  type JsonObject,
  type StandardSchemaV1,
  type ToolContext,
  type ToolResultOutput
} from "@arden-hq/loop"
import type { ApprovalEditOutcome } from "../persistence/tools/store.js"
import { sameJson } from "@arden-hq/std/json"

export interface ApprovalEditLine {
  readonly field: string
  readonly label: string
  readonly from: string
  readonly to: string
}

export interface ServerApprovalEdits<I> {
  readonly fields: ReadonlyArray<string>
  readonly check?: (input: I) => string | undefined
  readonly describe: (requested: I, edited: I) => ReadonlyArray<ApprovalEditLine>
}

export interface ApprovalEditor {
  readonly apply: (requested: JsonObject, patch: JsonObject) => ApprovalEditOutcome
}

const APPROVAL_EDITS_HEADER =
  "The user changed this call on the approval card before approving it. These values replace what you proposed; do not change them back:"

export const makeApprovalEditor = <S extends StandardSchemaV1>(
  parameters: S,
  edits: ServerApprovalEdits<StandardSchemaV1.InferOutput<S>>
): ApprovalEditor => ({
  apply: (requested, patch) => {
    const foreign = Object.keys(patch).filter((key) => !edits.fields.includes(key))
    if (foreign.length > 0) {
      return { _tag: "Refused", reason: `The card cannot change ${foreign.join(", ")}` }
    }
    const kept = Object.fromEntries(
      Object.entries(requested).filter(([key]) => !edits.fields.includes(key))
    )
    const merged: JsonObject = { ...kept, ...patch }
    if (sameJson(merged, requested)) return { _tag: "Unchanged" }
    const decoded = decodeSync(parameters, merged)
    if (decoded._tag === "Refused") return decoded
    const problem = edits.check?.(decoded.value)
    if (problem !== undefined) return { _tag: "Refused", reason: problem }
    return { _tag: "Edited", arguments: merged }
  }
})

export const executeEdited = async <S extends StandardSchemaV1, RunCtx>(
  definition: {
    readonly parameters: S
    readonly approvalEdits?: ServerApprovalEdits<StandardSchemaV1.InferOutput<S>>
    readonly execute: (
      input: StandardSchemaV1.InferOutput<S>,
      ctx: ToolContext<RunCtx>
    ) => Promise<ToolResultOutput | string>
  },
  input: StandardSchemaV1.InferOutput<S>,
  ctx: ToolContext<RunCtx>
): Promise<ToolResultOutput | string> => {
  const edited = ctx.approval?.edited
  if (edited === undefined) return definition.execute(input, ctx)
  const edits = definition.approvalEdits
  if (edits === undefined) throw refused("This tool takes no edits on its approval card")
  const changed = changedKeys(edited.requested, edited.arguments).filter(
    (key) => !edits.fields.includes(key)
  )
  if (changed.length > 0) throw refused(`The card cannot change ${changed.join(", ")}`)
  const requested = decodeSync(definition.parameters, edited.requested)
  if (requested._tag === "Refused") throw refused(requested.reason)
  const problem = edits.check?.(input)
  if (problem !== undefined) throw refused(problem)
  const lines = edits.describe(requested.value, input)
  const output = await definition.execute(input, ctx)
  const value = typeof output === "string" ? { result: output } : output
  if (lines.length === 0) return value
  return {
    ...value,
    result: [
      APPROVAL_EDITS_HEADER,
      ...lines.map((line) => `- ${line.label}: ${line.from} → ${line.to}`),
      "",
      value.result
    ].join("\n"),
    data: { ...value.data, approval_edits: lines }
  }
}

const refused = (reason: string): ToolExecutionError =>
  new ToolExecutionError(`The user's edits on the approval card were refused: ${reason}`, {
    preview: "Edits refused",
    retryable: false
  })

const decodeSync = <S extends StandardSchemaV1>(
  parameters: S,
  value: JsonObject
):
  | { readonly _tag: "Decoded"; readonly value: StandardSchemaV1.InferOutput<S> }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  const validated = parameters["~standard"].validate(value)
  if (validated instanceof Promise) {
    return { _tag: "Refused", reason: "This tool's arguments cannot be checked here" }
  }
  if (validated.issues !== undefined) {
    return {
      _tag: "Refused",
      reason: validated.issues.map((issue) => issueText(issue)).join("; ")
    }
  }
  return { _tag: "Decoded", value: validated.value }
}

const issueText = (issue: StandardSchemaV1.Issue): string => {
  const path = (issue.path ?? [])
    .map((segment) =>
      String(typeof segment === "object" && segment !== null ? segment.key : segment)
    )
    .join(".")
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message
}

const changedKeys = (left: JsonObject, right: JsonObject): ReadonlyArray<string> =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) => !sameJson(left[key], right[key])
  )
