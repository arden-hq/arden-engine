import {
  mutationReceiptHost,
  type MakeMutationReceiptInput
} from "../persistence/tools/mutation-receipt.js"
import type { ServerRunContext } from "./run-context.js"

type Resource = MakeMutationReceiptInput["resource"]
type NamedResource = Extract<Resource, { readonly kind: "versioned_resource" | "target" }>

export interface CallIdentity {
  readonly toolCallId: string
  readonly run: Pick<ServerRunContext, "runId">
}

export const appliedReceipt = (
  ctx: CallIdentity,
  resource: NamedResource | ReadonlyArray<NamedResource>
): Readonly<Record<string, unknown>> =>
  mutationReceiptHost({
    identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
    outcome: "applied",
    resource: isNamedList(resource) ? { kind: "resources", resources: resource } : resource
  })

const isNamedList = (
  resource: NamedResource | ReadonlyArray<NamedResource>
): resource is ReadonlyArray<NamedResource> => Array.isArray(resource)

export const chatTarget = (
  chat: { readonly sessionId: string; readonly publicRef: string; readonly turnId?: string },
  title: string
): NamedResource & { readonly href: string } => ({
  kind: "target",
  resourceRef: `session:${chat.sessionId}`,
  domain: "session",
  title,
  href: `arden:session/${encodeURIComponent(chat.publicRef)}${chat.turnId === undefined ? "" : `/${encodeURIComponent(chat.turnId)}`}`
})

export const inChatTarget = (input: {
  readonly resourceRef: string
  readonly title: string
  readonly chat: { readonly publicRef: string } | undefined
}): NamedResource => ({
  kind: "target",
  resourceRef: input.resourceRef,
  domain: "session",
  title: input.title,
  ...(input.chat === undefined
    ? {}
    : { href: `arden:session/${encodeURIComponent(input.chat.publicRef)}` })
})
