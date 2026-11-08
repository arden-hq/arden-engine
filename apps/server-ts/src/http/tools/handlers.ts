import type { ToolPolicy } from "@arden-hq/protocol/tools"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ServerToolRegistry } from "../../tools/registry.js"
import { ArdenApi } from "../api.js"

const policyResponse = (policy: ToolPolicy) => ({
  action: policy.action,
  scope: policy.scope,
  requires_approval: policy.requiresApproval,
  permissions: [...policy.permissions],
  concurrency_group: policy.concurrencyGroup,
  destructive: policy.destructive,
  open_world: policy.openWorld,
  idempotent: policy.idempotent
})

export const ToolHandlers = HttpApiBuilder.group(
  ArdenApi,
  "tools",
  Effect.fn(function* (handlers) {
    const registry = yield* ServerToolRegistry
    return handlers.handle("catalog", () =>
      registry.catalog().pipe(
        Effect.map(({ tools, unlisted }) => ({
          unlisted,
          tools: tools.map((tool) => ({
            name: tool.name,
            display_name: tool.displayName,
            description: tool.description,
            kind: tool.kind,
            source: tool.source,
            policy: policyResponse(tool.effectivePolicy),
            default_approval: tool.defaultApproval,
            display: tool.display
          }))
        })),
        Effect.mapError(() => new HttpApiError.InternalServerError({}))
      )
    )
  })
)
