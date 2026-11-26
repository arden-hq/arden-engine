import type { StandardSchemaV1 } from "../contracts/messages.js"
import type { JsonSchemaConverter } from "../tools/tool.js"
import { errorMessage } from "@arden-hq/std/errors"
import { parseJsonText } from "@arden-hq/std/json-text"

export interface AgentOutputOptions {
  readonly schema: StandardSchemaV1
  readonly toJsonSchema: JsonSchemaConverter
  readonly name?: string
}

export const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          String(typeof segment === "object" && segment !== null ? segment.key : segment)
        )
        .join(".")
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    .join("; ")

export const correctionContent = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  "Your final answer must be a single JSON object matching the required output schema. " +
  `It failed validation: ${formatIssues(issues) || "the value does not match the schema"}. ` +
  "Reply again with only the corrected JSON object."

type OutputValidation =
  | { readonly value: unknown }
  | { readonly issues: ReadonlyArray<StandardSchemaV1.Issue> }

export const validateOutputText = async (
  schema: StandardSchemaV1,
  text: string
): Promise<OutputValidation> => {
  let parsed: unknown
  try {
    parsed = parseJsonText(text)
  } catch (cause) {
    return { issues: [{ message: `the final text is not valid JSON: ${errorMessage(cause)}` }] }
  }
  let validated = schema["~standard"].validate(parsed)
  if (validated instanceof Promise) validated = await validated
  return validated.issues === undefined ? { value: validated.value } : { issues: validated.issues }
}
