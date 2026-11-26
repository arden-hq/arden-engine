import { Schema } from "effect"
import { withExtras } from "../common/schema.js"
import {
  TOOL_ACTION,
  TOOL_APPROVAL_OVERRIDE,
  TOOL_SCOPE,
  type ToolCatalogEntry,
  type ToolCatalogResponse,
  type ToolPolicy
} from "./contracts.js"
import { ToolDisplayWireSchema, toToolDisplay } from "./display.js"

const nonEmptyText = Schema.String.check(Schema.isMinLength(1))
const toolName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((name) =>
    name === name.trim() ? undefined : "must not have surrounding whitespace"
  )
)

export const ToolActionSchema = Schema.Literals(Object.values(TOOL_ACTION))
export const ToolScopeSchema = Schema.Literals(Object.values(TOOL_SCOPE))
export const ToolApprovalOverrideSchema = Schema.Literals(Object.values(TOOL_APPROVAL_OVERRIDE))
export const ToolDefaultApprovalSchema = Schema.Literals([
  TOOL_APPROVAL_OVERRIDE.approve,
  TOOL_APPROVAL_OVERRIDE.ask
])
const ToolPermissionListSchema = Schema.Array(nonEmptyText).check(
  Schema.makeFilter((permissions) =>
    new Set(permissions).size === permissions.length ? undefined : "contains duplicate permissions"
  )
)

export const ToolPolicySchema = withExtras({
  action: ToolActionSchema,
  scope: ToolScopeSchema,
  requires_approval: Schema.Boolean,
  permissions: ToolPermissionListSchema
})

export const ToolCatalogEntrySchema = withExtras({
  name: toolName,
  display_name: nonEmptyText,
  description: Schema.String,
  kind: nonEmptyText,
  source: nonEmptyText,
  policy: ToolPolicySchema,
  default_approval: ToolDefaultApprovalSchema,
  display: ToolDisplayWireSchema
}).check(
  Schema.makeFilter((tool) =>
    tool.default_approval === (tool.policy.requires_approval ? "ask" : "approve")
      ? undefined
      : { path: ["policy", "requires_approval"], issue: "must agree with the default approval" }
  )
)

export const ToolCatalogResponseSchema = withExtras({
  tools: Schema.Array(ToolCatalogEntrySchema),
  unlisted: Schema.Record(Schema.String, ToolDisplayWireSchema)
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
  const { action, scope, requires_approval, permissions, ...extras } = policy
  return {
    ...extras,
    action,
    scope,
    requiresApproval: requires_approval,
    permissions
  }
}

const mapToolCatalogEntry = (tool: ToolCatalogEntryWire): ToolCatalogEntry => {
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
    display: toToolDisplay(display)
  }
}

export const toToolCatalogResponse = (
  response: typeof ToolCatalogResponseSchema.Type
): ToolCatalogResponse => {
  const { tools, unlisted, ...extras } = response
  return {
    ...extras,
    tools: tools.map(mapToolCatalogEntry),
    unlisted: Object.fromEntries(
      Object.entries(unlisted).map(([name, wire]) => [name, toToolDisplay(wire)])
    )
  }
}
