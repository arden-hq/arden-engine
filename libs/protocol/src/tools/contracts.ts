import type { JsonRecord } from "../common/json.js"
import type { ToolDisplay } from "./display.js"

export type ToolAction = "read" | "draft" | "write" | "execute"
export type ToolScope = "internal" | "external"
export type ToolApprovalOverride = "approve" | "ask" | "deny"
export type ToolDefaultApproval = Exclude<ToolApprovalOverride, "deny">

/** The policy currently enforced by the server. */
export interface ToolPolicy extends JsonRecord {
  readonly action: ToolAction
  readonly scope: ToolScope
  readonly requiresApproval: boolean
  readonly permissions: ReadonlyArray<string>
  readonly concurrencyGroup: string | null
  readonly destructive: boolean | null
  readonly openWorld: boolean | null
  readonly idempotent: boolean | null
}

/** One registered tool as shown in application settings. This catalog is not
 * the filtered set of tools available to a particular model run. */
export interface ToolCatalogEntry extends JsonRecord {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly kind: string
  readonly source: string | null
  readonly effectivePolicy: ToolPolicy
  /** The declared policy expressed in the same vocabulary as the settings UI. */
  readonly defaultApproval: ToolDefaultApproval
  /** How its calls are shown (`display` in its metadata); empty for the generic row and card. */
  readonly display: ToolDisplay
}

export interface ToolCatalogResponse extends JsonRecord {
  readonly tools: ReadonlyArray<ToolCatalogEntry>
  /** Display facts for names a chat may carry that no listed tool has: a
   *  retired tool (`bash`, now `exec_command`) or one the model provider runs. */
  readonly unlisted: Readonly<Record<string, ToolDisplay>>
}
