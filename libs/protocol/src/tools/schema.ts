import { Schema } from "effect"
import { withExtras } from "../common/schema.js"
import type { ToolCatalogEntry, ToolCatalogResponse, ToolPolicy } from "./contracts.js"
import { LEGACY_TOOL_DISPLAY, ToolDisplayWireSchema, toToolDisplay } from "./display.js"

const nonEmptyText = Schema.String.check(Schema.isMinLength(1))
const toolName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((name) =>
    name === name.trim() ? undefined : "must not have surrounding whitespace"
  )
)

export const ToolActionSchema = Schema.Literals(["read", "draft", "write", "execute"] as const)
export const ToolScopeSchema = Schema.Literals(["internal", "external"] as const)
export const ToolApprovalOverrideSchema = Schema.Literals(["approve", "ask", "deny"] as const)
export const ToolDefaultApprovalSchema = Schema.Literals(["approve", "ask"] as const)
const ToolPermissionListSchema = Schema.Array(nonEmptyText).check(
  Schema.makeFilter((permissions) =>
    new Set(permissions).size === permissions.length ? undefined : "contains duplicate permissions"
  )
)

/** Effective wire policy mapped to the public camel-case contract. */
export const ToolPolicySchema = withExtras({
  action: ToolActionSchema,
  scope: ToolScopeSchema,
  requires_approval: Schema.Boolean,
  permissions: ToolPermissionListSchema,
  concurrency_group: Schema.NullOr(nonEmptyText),
  destructive: Schema.NullOr(Schema.Boolean),
  open_world: Schema.NullOr(Schema.Boolean),
  idempotent: Schema.NullOr(Schema.Boolean)
})

export const ToolCatalogEntrySchema = withExtras({
  name: toolName,
  display_name: nonEmptyText,
  description: Schema.String,
  kind: nonEmptyText,
  source: Schema.NullOr(nonEmptyText),
  policy: ToolPolicySchema,
  default_approval: ToolDefaultApprovalSchema,
  display: Schema.optionalKey(ToolDisplayWireSchema)
}).check(
  Schema.makeFilter((tool) =>
    tool.default_approval === (tool.policy.requires_approval ? "ask" : "approve")
      ? undefined
      : { path: ["policy", "requires_approval"], issue: "must agree with the default approval" }
  )
)

export const ToolCatalogResponseSchema = withExtras({
  tools: Schema.Array(ToolCatalogEntrySchema),
  /** Absent from a server that predates display facts. */
  unlisted: Schema.optionalKey(Schema.Record(Schema.String, ToolDisplayWireSchema))
}).check(
  Schema.makeFilter((response) => {
    const names = new Set(response.tools.map((tool) => tool.name))
    return names.size === response.tools.length
      ? undefined
      : { path: ["tools"], issue: "contains duplicate tool names" }
  })
)

type ToolPolicyWire = Schema.Schema.Type<typeof ToolPolicySchema>
type ToolCatalogEntryWire = Schema.Schema.Type<typeof ToolCatalogEntrySchema>

const mapToolPolicy = (policy: ToolPolicyWire): ToolPolicy => {
  const {
    action,
    scope,
    requires_approval,
    permissions,
    concurrency_group,
    destructive,
    open_world,
    idempotent,
    ...extras
  } = policy
  return {
    ...extras,
    action,
    scope,
    requiresApproval: requires_approval,
    permissions,
    concurrencyGroup: concurrency_group,
    destructive,
    openWorld: open_world,
    idempotent
  }
}

const mapToolCatalogEntry = (tool: ToolCatalogEntryWire, legacy: boolean): ToolCatalogEntry => {
  const {
    name,
    display_name,
    description,
    kind,
    source,
    policy,
    default_approval,
    display,
    displayName: _publicDisplayName,
    effectivePolicy: _publicEffectivePolicy,
    defaultApproval: _publicDefaultApproval,
    ...extras
  } = tool
  return {
    ...extras,
    name,
    displayName: display_name,
    description,
    kind,
    source,
    effectivePolicy: mapToolPolicy(policy),
    defaultApproval: default_approval,
    display: legacy ? (LEGACY_TOOL_DISPLAY[name] ?? {}) : toToolDisplay(display ?? {})
  }
}

export const toToolCatalogResponse = (
  response: typeof ToolCatalogResponseSchema.Type
): ToolCatalogResponse => {
  const { tools, unlisted, ...extras } = response
  const legacy = unlisted === undefined
  const listed = new Set(tools.map((tool) => tool.name))
  return {
    ...extras,
    tools: tools.map((tool) => mapToolCatalogEntry(tool, legacy)),
    unlisted: Object.fromEntries(
      legacy
        ? Object.entries(LEGACY_TOOL_DISPLAY).filter(([name]) => !listed.has(name))
        : Object.entries(unlisted).map(([name, wire]) => [name, toToolDisplay(wire)])
    )
  }
}
