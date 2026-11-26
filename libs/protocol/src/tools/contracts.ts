import type { JsonRecord } from "../common/json.js"
import type { ToolDisplay } from "./display.js"

export const TOOL_ACTION = {
  read: "read",
  draft: "draft",
  write: "write",
  execute: "execute"
} as const
export type ToolAction = (typeof TOOL_ACTION)[keyof typeof TOOL_ACTION]
export const TOOL_SCOPE = { internal: "internal", external: "external" } as const
export type ToolScope = (typeof TOOL_SCOPE)[keyof typeof TOOL_SCOPE]
export const TOOL_APPROVAL_OVERRIDE = { approve: "approve", ask: "ask", deny: "deny" } as const
export type ToolApprovalOverride =
  (typeof TOOL_APPROVAL_OVERRIDE)[keyof typeof TOOL_APPROVAL_OVERRIDE]
export type ToolDefaultApproval = Exclude<ToolApprovalOverride, typeof TOOL_APPROVAL_OVERRIDE.deny>

export interface ToolPolicy extends JsonRecord {
  readonly action: ToolAction
  readonly scope: ToolScope
  readonly requiresApproval: boolean
  readonly permissions: ReadonlyArray<string>
}

export interface ToolCatalogEntry extends JsonRecord {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly kind: string
  readonly source: string
  readonly effectivePolicy: ToolPolicy
  readonly defaultApproval: ToolDefaultApproval
  readonly display: ToolDisplay
}

export interface ToolCatalogResponse extends JsonRecord {
  readonly tools: ReadonlyArray<ToolCatalogEntry>
  readonly unlisted: Readonly<Record<string, ToolDisplay>>
}
