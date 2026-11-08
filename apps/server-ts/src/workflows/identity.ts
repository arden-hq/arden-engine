import { canonicalJson } from "@arden-hq/std/json"
import { Schema } from "effect"
import { sha256Bytes, sha256Hex } from "@arden-hq/std/hash"

interface WorkflowNodeSpecification {
  readonly prompt: string
  readonly mode: "research" | "code"
  readonly model: string | null
  readonly reasoning_effort: string | null
  readonly label: string | null
  readonly phase: string | null
  readonly schema: Readonly<Record<string, Schema.Json>> | null
  readonly execution_profile_hash: string
}

export interface WorkflowNodeIdentity {
  readonly logicalKey: string
  readonly specificationHash: string
  readonly specification: WorkflowNodeSpecification
}

export const workflowHash = (value: Schema.Json): string => sha256Hex(canonicalJson(value))

export const scriptReference = (input: {
  readonly originRunId: string
  readonly originToolCallId: string
}): string =>
  `wf-${workflowHash({
    origin_run_id: input.originRunId,
    origin_tool_call_id: input.originToolCallId
  }).slice(0, 32)}`

export const workflowOperationId = (...parts: ReadonlyArray<string>): string => {
  const bytes = sha256Bytes(canonicalJson([...parts])).subarray(0, 16)
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x40
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-")
}

export const workflowNodeIdentity = (input: {
  readonly prompt: string
  readonly mode: "research" | "code"
  readonly model?: string
  readonly reasoningEffort?: string
  readonly label: string | undefined
  readonly key: string | undefined
  readonly phase: string | undefined
  readonly schema: Readonly<Record<string, Schema.Json>> | undefined
  readonly occurrence: number
  readonly executionProfileHash: string
}): WorkflowNodeIdentity => {
  const specification = {
    prompt: input.prompt,
    mode: input.mode,
    model: input.model ?? null,
    reasoning_effort: input.reasoningEffort ?? null,
    label: input.label ?? null,
    phase: input.phase ?? null,
    schema: input.schema ?? null,
    execution_profile_hash: input.executionProfileHash
  } satisfies WorkflowNodeSpecification
  const specificationHash = workflowHash(specification)
  return {
    logicalKey: input.key ?? `auto:${specificationHash.slice(0, 32)}:${input.occurrence}`,
    specificationHash,
    specification
  }
}
