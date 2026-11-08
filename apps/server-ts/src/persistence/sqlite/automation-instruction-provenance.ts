import { Effect, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { AutomationTriggersSchema } from "./automation-schedule.js"
import { sha256Hex } from "@arden-hq/std/hash"

export interface AutomationWriteSource {
  readonly runId: string
  readonly toolCallId: string
}

export interface InstructionRow {
  readonly name: string
  readonly description: string | null
  readonly prompt: string
  readonly model: string | null
  readonly context_mode: string
  readonly triggers: string
  readonly thread_id: string | null
  readonly cooldown_minutes: number | null
  readonly prompt_author: string | null
  readonly instruction_revision_id: number | null
}

export type InstructionSnapshot = Pick<
  InstructionRow,
  "prompt" | "model" | "context_mode" | "triggers" | "thread_id" | "cooldown_minutes"
>

export type InstructionDestination =
  | { readonly kind: "own" }
  | { readonly kind: "yours"; readonly publicRef: string }

export const instructionDestination = Effect.fn("Automation.instructionDestination")(function* (
  sql: SqlClient.SqlClient,
  automationId: string,
  sessionId: string | null
) {
  if (sessionId === null) return undefined
  const [row] = yield* sql<{
    readonly origin_automation_id: string | null
    readonly public_ref: string | null
  }>`SELECT origin_automation_id, public_ref FROM sessions
      WHERE session_id = ${sessionId} LIMIT 1`
  if (row === undefined) return undefined
  if (row.origin_automation_id === automationId) return { kind: "own" as const }
  if (row.origin_automation_id !== null || row.public_ref === null) return undefined
  return { kind: "yours" as const, publicRef: row.public_ref }
})

export const instructionPayload = (row: InstructionSnapshot): string =>
  JSON.stringify({
    prompt: row.prompt,
    model: row.model,
    context_mode: row.context_mode,
    triggers: Schema.decodeUnknownSync(AutomationTriggersSchema)(
      JSON.parse(row.triggers) as unknown
    ),
    thread_id: row.thread_id,
    cooldown_minutes: row.cooldown_minutes
  })

export const instructionHash = (payload: string): string => sha256Hex(payload)

const field = (object: unknown, key: string): unknown =>
  Predicate.isObject(object) ? object[key] : undefined

export const matchesInstructionReceipt = (input: {
  readonly result: unknown
  readonly args: unknown
  readonly toolName: string
  readonly automationRef: string | undefined
  readonly instruction: InstructionSnapshot
  readonly destination: InstructionDestination | undefined
}): boolean => {
  const data = field(input.result, "data")
  const host = field(input.result, "host")
  const receipt = field(host, "mutation_receipt")
  if (
    input.automationRef === undefined ||
    field(input.result, "is_error") === true ||
    field(receipt, "outcome") !== "applied" ||
    field(data, "automation_ref") !== input.automationRef ||
    field(data, "prompt") !== input.instruction.prompt ||
    field(data, "model") !== input.instruction.model ||
    field(data, "cooldown_minutes") !== input.instruction.cooldown_minutes ||
    field(data, "history") !== (input.instruction.context_mode === "fresh" ? "fresh" : "chat") ||
    JSON.stringify(field(data, "triggers")) !==
      JSON.stringify(
        Schema.decodeUnknownSync(AutomationTriggersSchema)(
          JSON.parse(input.instruction.triggers) as unknown
        )
      )
  )
    return false
  if (input.destination === undefined) return false
  if (input.destination.kind === "own") {
    if (field(data, "chat") !== "own" || field(data, "chat_ref") != null) return false
  } else if (
    field(data, "chat") !== "yours" ||
    field(data, "chat_ref") !== input.destination.publicRef
  )
    return false
  if (input.toolName === "automation_update")
    return field(input.args, "automation_ref") === input.automationRef
  return (
    input.toolName === "automation_create" &&
    field(input.args, "prompt") === input.instruction.prompt
  )
}

export const prepareInstructionRevision = Effect.fn("Automation.prepareInstructionRevision")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly automationId: string
      readonly instruction: InstructionSnapshot
      readonly previousRevisionId: number | null
      readonly promptAuthor: string | null
      readonly source: AutomationWriteSource | undefined
      readonly toolName: "automation_create" | "automation_update"
      readonly writtenAt: string
    }
  ) {
    const payload = instructionPayload(input.instruction)
    const hash = instructionHash(payload)
    if (input.previousRevisionId !== null) {
      const [previous] = yield* sql<{ readonly instruction_hash: string }>`
        SELECT instruction_hash FROM automation_instruction_revisions
        WHERE revision_id = ${input.previousRevisionId} AND task_id = ${input.automationId}`
      if (previous === undefined) throw new Error("Automation instruction revision is missing")
      if (previous.instruction_hash === hash) return input.previousRevisionId
    }
    if (input.source !== undefined) {
      const [call] = yield* sql<{ readonly tool_call_id: string }>`
        SELECT tool_call_id FROM tool_calls
        WHERE run_id = ${input.source.runId}
          AND tool_call_id = ${input.source.toolCallId}
          AND tool_name = ${input.toolName} AND status = 'running' LIMIT 1`
      if (call === undefined) throw new Error("Automation write source is not a running tool call")
    }
    const [created] = yield* sql<{ readonly revision_id: number }>`
      INSERT INTO automation_instruction_revisions (
        task_id, instruction_json, instruction_hash,
        prompt_author, source_run_id, source_tool_call_id, written_at
      ) VALUES (
        ${input.automationId}, ${payload}, ${hash},
        ${input.promptAuthor}, ${input.source?.runId ?? null}, ${input.source?.toolCallId ?? null},
        ${input.writtenAt}
      ) RETURNING revision_id`
    if (created === undefined) throw new Error("Automation instruction revision was not saved")
    return created.revision_id
  }
)
