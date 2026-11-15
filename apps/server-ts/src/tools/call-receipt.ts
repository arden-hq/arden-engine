import { Effect } from "effect"

import type { SessionQueries } from "../persistence/sessions/queries.js"
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

/** The link to a chat, or to one turn of it. */
export const chatHref = (chat: { readonly publicRef: string; readonly turnId?: string }): string =>
  `arden:session/${encodeURIComponent(chat.publicRef)}${chat.turnId === undefined ? "" : `/${encodeURIComponent(chat.turnId)}`}`

/** The link to the chat with this id, or undefined when that chat no longer exists. */
export const chatLinkOf = async (
  sessions: Pick<SessionQueries["Service"], "loadHistoryHeader">,
  sessionId: string,
  signal: AbortSignal
): Promise<string | undefined> => {
  const header = await Effect.runPromise(
    sessions.loadHistoryHeader(sessionId).pipe(Effect.orElseSucceed(() => null)),
    { signal }
  )
  return header === null ? undefined : chatHref(header)
}

export const chatTarget = (
  chat: { readonly sessionId: string; readonly publicRef: string; readonly turnId?: string },
  title: string
): NamedResource & { readonly href: string } => ({
  kind: "target",
  resourceRef: `session:${chat.sessionId}`,
  domain: "session",
  title,
  href: chatHref(chat)
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
  ...(input.chat === undefined ? {} : { href: chatHref(input.chat) })
})
