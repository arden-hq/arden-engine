import { PERMISSION_RULE_SUBJECT } from "@arden-hq/protocol/permissions"
import { Option, Schema } from "effect"

import { RuleSubjectSchema, type RuleSubject } from "./rules.js"

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

export const toolGrantSubject = (toolName: string, data: unknown): RuleSubject | undefined => {
  const grant = Schema.decodeUnknownOption(ToolGrantApprovalDataSchema)(data)
  if (Option.isNone(grant)) return undefined
  const { subject } = grant.value[TOOL_GRANT]
  const own =
    (subject.kind === PERMISSION_RULE_SUBJECT.tool &&
      subject.server === null &&
      subject.tool === toolName) ||
    (subject.kind === PERMISSION_RULE_SUBJECT.site && subject.tool === toolName)
  return own ? subject : undefined
}
