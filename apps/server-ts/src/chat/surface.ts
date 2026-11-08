export type Surface = "conversation" | "work"

export interface SurfaceCall {
  readonly presentation?: unknown
  readonly kind?: unknown
}

export type SurfacePart =
  | { readonly type: "text" }
  | { readonly type: "reasoning" }
  | {
      readonly type: "tool_call"
      readonly tool_call_id: string
      readonly execution: "runtime" | "provider"
    }

export const conversationCall = (call: SurfaceCall): boolean => call.presentation === "conversation"

export const surfaceOfCall = (call: SurfaceCall, execution: "runtime" | "provider"): Surface =>
  execution === "runtime" && conversationCall(call) ? "conversation" : "work"

export const surfaceOfPart = (
  part: SurfacePart,
  callsById: ReadonlyMap<string, SurfaceCall>
): Surface => {
  switch (part.type) {
    case "text":
      return "conversation"
    case "reasoning":
      return "work"
    case "tool_call":
      return surfaceOfCall(callsById.get(part.tool_call_id) ?? {}, part.execution)
  }
}
