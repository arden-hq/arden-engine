import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import type { ComputerSetup } from "@arden-hq/protocol/computer"

const Pending = Schema.Struct({ exit_code: Schema.Literal(75) })
const Envelope = Schema.Struct({ content: Schema.Array(Schema.Unknown) })
const Grants = Schema.Struct({
  accessibility: Schema.Literal(true),
  screen_recording: Schema.Literal(true)
})

export function permissionGrantState(raw: unknown): ComputerSetup["permissions"] {
  if (!Schema.is(Envelope)(raw)) throw new Error("Cua did not return a permission check result")
  const result = CallToolResultSchema.parse(raw)
  if (result.isError || !Schema.is(Grants)(result.structuredContent))
    throw new Error(
      "Allow CuaDriver under Accessibility and Screen Recording in System Settings, then try again."
    )
  return { kind: "granted" }
}

/** Cua's open socket is reachable before its first-launch permission gate finishes. */
export function permissionSessionState(raw: unknown): "ready" | "pending" {
  // The SDK supplies default content; a detached result is not a native session receipt.
  if (!Schema.is(Envelope)(raw)) throw new Error("Cua did not return a computer-use session result")
  const result = CallToolResultSchema.parse(raw)
  if (!result.isError) return "ready"
  if (
    Schema.is(Pending)(result.structuredContent) &&
    result.content.some(
      (part) => part.type === "text" && part.text.startsWith("permissions_pending:")
    )
  )
    return "pending"
  throw new Error("Cua could not initialize the computer-use session")
}
