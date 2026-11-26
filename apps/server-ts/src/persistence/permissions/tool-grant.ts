import { Option, Schema } from "effect"

import { RuleSubjectSchema, type RuleSubject } from "./rules.js"

/**
 * The rule a built-in tool's card may save with "Always allow", kept on the
 * card's data by the approval gate. It is there only when the gate asked for
 * a reason an Allow rule answers, so the card never offers a rule that would
 * still leave the next call asking.
 */
export const TOOL_GRANT = "tool_grant"

const ToolGrantApprovalDataSchema = Schema.Struct({
  [TOOL_GRANT]: Schema.Struct({ subject: RuleSubjectSchema })
})

export interface ToolGrantData {
  readonly tool_grant: { readonly subject: RuleSubject }
}

export const toolGrantData = (subject: RuleSubject): ToolGrantData => ({
  [TOOL_GRANT]: { subject }
})

/** The subject the gate kept for this tool's card; a subject for any other tool is ignored. */
export const toolGrantSubject = (toolName: string, data: unknown): RuleSubject | undefined => {
  const grant = Schema.decodeUnknownOption(ToolGrantApprovalDataSchema)(data)
  if (Option.isNone(grant)) return undefined
  const { subject } = grant.value[TOOL_GRANT]
  const own =
    (subject.kind === "tool" && subject.server === null && subject.tool === toolName) ||
    (subject.kind === "site" && subject.tool === toolName)
  return own ? subject : undefined
}
