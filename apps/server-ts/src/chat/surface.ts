import { ASSISTANT_OUTPUT_PART_TYPE } from "@arden-hq/loop"
import { TOOL_PRESENTATION } from "@arden-hq/protocol/chat"
import { TOOL_EXECUTION } from "@arden-hq/std/message-vocabulary"
export const SURFACE = { conversation: "conversation", work: "work" } as const

export type Surface = (typeof SURFACE)[keyof typeof SURFACE]

export interface SurfaceCall {
  readonly presentation?: unknown
  readonly kind?: unknown
}

export type SurfacePart =
  | { readonly type: typeof ASSISTANT_OUTPUT_PART_TYPE.text }
  | { readonly type: typeof ASSISTANT_OUTPUT_PART_TYPE.reasoning }
  | {
      readonly type: typeof ASSISTANT_OUTPUT_PART_TYPE.toolCall
      readonly tool_call_id: string
      readonly execution: "runtime" | "provider"
    }

export const conversationCall = (call: SurfaceCall): boolean =>
  call.presentation === TOOL_PRESENTATION.conversation

export const surfaceOfCall = (call: SurfaceCall, execution: "runtime" | "provider"): Surface =>
  execution === TOOL_EXECUTION.runtime && conversationCall(call) ? "conversation" : "work"

export const surfaceOfPart = (
  part: SurfacePart,
  callsById: ReadonlyMap<string, SurfaceCall>
): Surface => {
  switch (part.type) {
    case ASSISTANT_OUTPUT_PART_TYPE.text:
      return "conversation"
    case ASSISTANT_OUTPUT_PART_TYPE.reasoning:
      return "work"
    case ASSISTANT_OUTPUT_PART_TYPE.toolCall:
      return surfaceOfCall(callsById.get(part.tool_call_id) ?? {}, part.execution)
  }
}
