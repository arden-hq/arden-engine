import type { StandardSchemaV1 } from "../contracts/messages.js"
import type { JsonSchemaConverter } from "../tools/tool.js"
import { errorMessage } from "@arden-hq/std/errors"

/**
 * Structured output for one invocation. The JSON-Schema response format is
 * carried to the provider on every model request of the run (a format only
 * constrains emitted text, so tool-calling turns are unaffected); validation
 * applies to the FINAL text turn only. On validation failure the loop makes
 * ONE correction retry — a user message quoting the issues, then a re-run of
 * the final turn — before failing with `StructuredOutputError`.
 */
export interface AgentOutputOptions {
  readonly schema: StandardSchemaV1
  /** Host-supplied Standard-Schema→JSON-Schema conversion (e.g. `z.toJSONSchema`). */
  readonly toJsonSchema: JsonSchemaConverter
  /** Provider-facing schema name (default "output"). */
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
    parsed = JSON.parse(text)
  } catch (cause) {
    return { issues: [{ message: `the final text is not valid JSON: ${errorMessage(cause)}` }] }
  }
  let validated = schema["~standard"].validate(parsed)
  if (validated instanceof Promise) validated = await validated
  return validated.issues === undefined ? { value: validated.value } : { issues: validated.issues }
}
