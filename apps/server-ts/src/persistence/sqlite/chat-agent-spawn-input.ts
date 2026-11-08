import { isWithin } from "@arden-hq/std/paths"
import { Schema } from "effect"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import { JsonObjectSchema } from "../json.js"

const SpawnAgentInputBaseSchema = Schema.Struct({
  taskItemId: Schema.optionalKey(Schema.NonEmptyString),
  outputSchema: Schema.optionalKey(JsonObjectSchema),
  parent: Schema.Struct({
    runId: Schema.NonEmptyString,
    sessionId: Schema.NonEmptyString,
    toolCallId: Schema.NonEmptyString,
    toolName: Schema.NonEmptyString,
    arguments: JsonObjectSchema,
    changesState: Schema.Boolean
  }),
  name: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
  task: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  model: Schema.optionalKey(Schema.NonEmptyString),
  reasoningEffort: Schema.optionalKey(Schema.NonEmptyString),
  forkHistory: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))
})

export const spawnAgentInputSchema = Schema.Union([
  Schema.Struct({
    ...SpawnAgentInputBaseSchema.fields,
    mode: Schema.Literal("research")
  }),
  Schema.Struct({
    ...SpawnAgentInputBaseSchema.fields,
    mode: Schema.Literal("work")
  }),
  Schema.Struct({
    ...SpawnAgentInputBaseSchema.fields,
    mode: Schema.Literal("code"),
    requestedWorkingDirectory: Schema.optionalKey(Schema.NonEmptyString),
    workspace: Schema.Struct({
      root: Schema.NonEmptyString,
      cwd: Schema.NonEmptyString
    })
  })
]).check(
  Schema.makeFilter((input) => {
    const argumentTask = input.parent.arguments.task
    const argumentName = input.parent.arguments.name
    const argumentMode = input.parent.arguments.mode
    const argumentWorkingDirectory = input.parent.arguments.working_directory
    const argumentModel = input.parent.arguments.model
    const argumentReasoningEffort = input.parent.arguments.reasoning_effort
    const issues: Array<Schema.FilterIssue> = []
    if (input.parent.arguments.task_item_id !== input.taskItemId) {
      issues.push({
        path: ["parent", "arguments", "task_item_id"],
        issue: "must match the attached Task"
      })
    }
    if (!isDeepStrictEqual(input.parent.arguments.output_schema, input.outputSchema)) {
      issues.push({
        path: ["parent", "arguments", "output_schema"],
        issue: "must match output schema"
      })
    }
    if (input.parent.toolName !== "spawn_agent") {
      issues.push({ path: ["parent", "toolName"], issue: "must be spawn_agent" })
    }
    if (!input.parent.changesState) {
      issues.push({ path: ["parent", "changesState"], issue: "must be true" })
    }
    if (typeof argumentTask !== "string" || argumentTask.trim() !== input.task) {
      issues.push({
        path: ["parent", "arguments", "task"],
        issue: "must match task after trimming"
      })
    }
    if (
      (input.name === undefined && argumentName !== undefined) ||
      (input.name !== undefined &&
        (typeof argumentName !== "string" || argumentName.trim() !== input.name))
    ) {
      issues.push({
        path: ["parent", "arguments", "name"],
        issue: "must match name after trimming"
      })
    }
    if (argumentMode !== input.mode) {
      issues.push({ path: ["parent", "arguments", "mode"], issue: "must match mode" })
    }
    if ((input.parent.arguments.fork_context === true) !== (input.forkHistory !== undefined)) {
      issues.push({
        path: ["parent", "arguments", "fork_context"],
        issue: "must be true exactly when the parent's history is forked"
      })
    }
    if (argumentModel !== input.model) {
      issues.push({ path: ["parent", "arguments", "model"], issue: "must match model" })
    }
    if (input.forkHistory !== undefined && input.model !== undefined) {
      issues.push({ path: ["model"], issue: "a forked child inherits the parent model" })
    }
    if (argumentReasoningEffort !== input.reasoningEffort) {
      issues.push({
        path: ["parent", "arguments", "reasoning_effort"],
        issue: "must match reasoning effort"
      })
    }
    if (input.mode !== "code") {
      if (argumentWorkingDirectory !== undefined) {
        issues.push({
          path: ["parent", "arguments", "working_directory"],
          issue: "is available only when mode is code"
        })
      }
    } else {
      if (
        (input.requestedWorkingDirectory === undefined && argumentWorkingDirectory !== undefined) ||
        (input.requestedWorkingDirectory !== undefined &&
          argumentWorkingDirectory !== input.requestedWorkingDirectory)
      ) {
        issues.push({
          path: ["parent", "arguments", "working_directory"],
          issue: "must match requestedWorkingDirectory"
        })
      }
      if (!path.isAbsolute(input.workspace.root) || !path.isAbsolute(input.workspace.cwd)) {
        issues.push({ path: ["workspace"], issue: "must contain absolute paths" })
      } else if (!isWithin(input.workspace.root, input.workspace.cwd)) {
        issues.push({ path: ["workspace", "cwd"], issue: "must be inside workspace.root" })
      }
    }
    return issues
  })
)
