import { ToolExecutionError, type StandardSchemaV1, type ToolContext } from "@arden-hq/loop"
import { GOOGLE_GRANTS, type GoogleGrant } from "@arden-hq/protocol/google"

import {
  defineServerTool,
  type ServerTool,
  type ServerToolDefinition,
  type ServerApprovalPrompt
} from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { googleGrantAccess, grantReadCard, withGrantNeed } from "./google-grant-card.js"
import type { ServerRunContext } from "./run-context.js"

export interface GoogleGrantDescription {
  readonly grant: GoogleGrant
  readonly what: string
  readonly note: string
}

export interface GoogleToolGrant<Input> extends GoogleGrantDescription {
  readonly target: (input: Input) => { readonly accountRef: string | undefined } | undefined
  readonly validate?: (input: Input, ctx: ToolContext<ServerRunContext>) => Promise<void>
}

const missingGrantAccount = (
  google: GoogleToolConnections,
  need: GoogleGrantDescription,
  target: { readonly accountRef: string | undefined } | undefined
): string | undefined => {
  if (target === undefined) return undefined
  const access = googleGrantAccess(
    google.accounts(),
    target.accountRef,
    GOOGLE_GRANTS[need.grant].service,
    need.grant
  )
  return access.kind === "missing" ? access.account.email : undefined
}

export const requireGoogleGrant = ({
  google,
  need,
  target
}: {
  readonly google: GoogleToolConnections
  readonly need: GoogleGrantDescription
  readonly target: { readonly accountRef: string | undefined } | undefined
}): void => {
  const account = missingGrantAccount(google, need, target)
  if (account === undefined) return
  throw new ToolExecutionError(
    `Arden is not allowed to ${need.what} for ${account} yet. Approve the tool's card to ask Google for access. The requested operation was not run.`,
    { preview: "Google permission required", retryable: false }
  )
}

export const defineGoogleTool = <S extends StandardSchemaV1>({
  google,
  grant,
  ...definition
}: Omit<ServerToolDefinition<S>, "approvalRequirement" | "approvalDraft"> & {
  readonly google: GoogleToolConnections
  readonly grant: GoogleToolGrant<StandardSchemaV1.InferOutput<S>>
}): ServerTool => {
  const card = async (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<ServerRunContext>,
    account: string
  ): Promise<ServerApprovalPrompt> => {
    const prompt =
      definition.approvalPrompt === undefined
        ? grantReadCard({ ...grant, account })
        : withGrantNeed(await definition.approvalPrompt(input, ctx), { ...grant, account })
    if (prompt.presentation?.needs_grant === undefined) {
      throw new Error(`Google grant card for ${definition.name} needs a presentation`)
    }
    return { ...prompt, data: { ...prompt.data, reviewer: "user" } }
  }
  return defineServerTool({
    ...definition,
    metadata: { ...definition.metadata, requirement: "boundary" },
    approvalRequirement: async (input, ctx) => {
      const account = missingGrantAccount(google, grant, grant.target(input))
      if (account !== undefined) return card(input, ctx, account)
      await grant.validate?.(input, ctx)
      return undefined
    },
    execute: async (input, ctx, effects) => {
      requireGoogleGrant({ google, need: grant, target: grant.target(input) })
      await grant.validate?.(input, ctx)
      return definition.execute(input, ctx, effects)
    }
  })
}
