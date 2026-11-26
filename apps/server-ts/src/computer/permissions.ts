import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { CONTENT_BLOCK_TYPE } from "@arden-hq/loop"
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

export const PERMISSION_SESSION_STATE = { ready: "ready", pending: "pending" } as const

type PermissionSessionState =
  (typeof PERMISSION_SESSION_STATE)[keyof typeof PERMISSION_SESSION_STATE]

const PENDING_PERMISSIONS_PREFIX = "permissions_pending:"

export function permissionSessionState(raw: unknown): PermissionSessionState {
  if (!Schema.is(Envelope)(raw)) throw new Error("Cua did not return a computer-use session result")
  const result = CallToolResultSchema.parse(raw)
  if (!result.isError) return PERMISSION_SESSION_STATE.ready
  if (
    Schema.is(Pending)(result.structuredContent) &&
    result.content.some(
      (part) =>
        part.type === CONTENT_BLOCK_TYPE.text && part.text.startsWith(PENDING_PERMISSIONS_PREFIX)
    )
  )
    return PERMISSION_SESSION_STATE.pending
  throw new Error("Cua could not initialize the computer-use session")
}
