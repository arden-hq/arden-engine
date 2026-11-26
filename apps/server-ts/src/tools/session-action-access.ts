import { ToolExecutionError, type ToolApprovalContext, type ToolContext } from "@arden-hq/loop"
import type { ApprovalPresentationDraft } from "../persistence/tools/approval-draft.js"
import { Effect } from "effect"

import { type ServerApprovalPrompt } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import {
  SessionLifecycleEvents,
  type SessionLifecycleEventError
} from "../persistence/sessions/events.js"
import {
  SessionStore,
  type SessionListEntry,
  type SessionListQuery,
  type SessionStoreError
} from "../persistence/sessions/store.js"
import { ToolExecutionStore } from "../persistence/tools/store.js"
import { WorkStore } from "../persistence/work/store.js"
import { toolFailure } from "./tool-failure.js"
import { STORE_REASON } from "../persistence/errors.js"
import { VERDICT } from "../execution/decide.js"
import {
  otherSpaceReach,
  sessionMiss,
  unreachableSession,
  type ChatVerb
} from "./session-visibility.js"
import { Wiki } from "../wiki/service.js"

export interface SessionActionToolServices {
  readonly store: SessionStore["Service"]
  readonly queries: SessionQueries["Service"]
  readonly automations: AutomationCatalog["Service"]
  readonly spaces: SpaceStore["Service"]
  readonly work: WorkStore["Service"]
  readonly wiki: Wiki["Service"]
  readonly events: SessionLifecycleEvents["Service"]
  readonly executions: ToolExecutionStore["Service"]
}

export interface SourceRef {
  readonly provider: "arden"
  readonly kind: "session"
  readonly ref: string
  readonly title: string
}

export const sessionFailure = (error: SessionStoreError): ToolExecutionError =>
  toolFailure(
    error,
    error.reason === STORE_REASON.conflict ? "Session changed" : "Session unavailable"
  )

export const sessionQueryFailure = (error: SessionQueryFailure): ToolExecutionError =>
  toolFailure(error, "Session unavailable")

export const eventFailure = (error: SessionLifecycleEventError): ToolExecutionError =>
  toolFailure(error, "App request unavailable")

const currentScope = async (
  queries: SessionQueries["Service"],
  sessionId: string,
  signal: AbortSignal
): Promise<SessionListQuery> => {
  const header = await Effect.runPromise(
    queries.loadHistoryHeader(sessionId).pipe(Effect.mapError(sessionQueryFailure)),
    { signal }
  )
  if (header === null) {
    throw new ToolExecutionError("The current Session no longer exists", {
      preview: "Session not found",
      retryable: false
    })
  }
  return {
    scope: "all",
    ...(header.spaceId === null ? {} : { spaceId: header.spaceId })
  }
}

export const findSession = async (
  services: SessionActionToolServices,
  requestingSessionId: string,
  sessionRef: string,
  signal: AbortSignal
): Promise<SessionListEntry | undefined> => {
  const scope = await currentScope(services.queries, requestingSessionId, signal)
  return listOne(services, { ...scope, sessionRef }, signal)
}

const listOne = async (
  services: SessionActionToolServices,
  query: SessionListQuery,
  signal: AbortSignal
): Promise<SessionListEntry | undefined> => {
  const matches = await Effect.runPromise(
    services.store.list({ ...query, limit: 1 }).pipe(Effect.mapError(sessionFailure)),
    { signal }
  )
  return matches[0]
}

interface ChatAccess {
  readonly run: ServerRunContext
  readonly tool: string
  readonly verb: ChatVerb
  readonly handed: boolean
}

const reachSession = async (
  services: SessionActionToolServices,
  access: ChatAccess,
  sessionRef: string,
  signal: AbortSignal
): Promise<{ readonly session: SessionListEntry; readonly otherSpace: boolean }> => {
  const here = await findSession(services, access.run.sessionId, sessionRef, signal)
  if (here !== undefined) return { session: here, otherSpace: false }
  const elsewhere = await listOne(services, { scope: "all", sessionRef }, signal)
  if (elsewhere !== undefined) return { session: elsewhere, otherSpace: true }
  const miss = await sessionMiss(services.queries, sessionRef, signal)
  throw unreachableSession(sessionRef, miss, access.run.authority.actor)
}

const crossSpace = (access: ChatAccess, approved: boolean): "allow" | "ask" | "deny" =>
  otherSpaceReach({
    authority: access.run.authority,
    verb: access.verb,
    handed: access.handed,
    mode: access.run.approvalMode,
    approved
  })

export const resolveSession = async (
  services: SessionActionToolServices,
  access: ChatAccess & {
    readonly approval?: ToolApprovalContext | undefined
  },
  sessionRef: string,
  signal: AbortSignal
): Promise<SessionListEntry> => {
  const { session, otherSpace } = await reachSession(services, access, sessionRef, signal)
  if (!otherSpace) return session
  const approved = access.approval?.data?.["session_id"] === session.sessionId
  if (crossSpace(access, approved) === VERDICT.allow) return session
  throw unreachableSession(sessionRef, "other_space", access.run.authority.actor)
}

export const otherSpaceCard = async (
  services: SessionActionToolServices,
  ctx: ToolContext<ServerRunContext>,
  tool: "session_send_message" | "forward_message",
  sessionRef: string,
  handed: boolean,
  card: (target: { readonly name: string; readonly space: string }) => {
    readonly preview: string
    readonly presentation: Omit<ApprovalPresentationDraft, "fields">
  }
): Promise<ServerApprovalPrompt | undefined> => {
  const access = { run: ctx.run, tool, verb: "message", handed } as const
  const { session, otherSpace } = await reachSession(services, access, sessionRef, ctx.signal)
  if (!otherSpace) return undefined
  const reach = crossSpace(access, false)
  if (reach === VERDICT.deny)
    throw unreachableSession(sessionRef, "other_space", ctx.run.authority.actor)
  if (reach === VERDICT.allow) return undefined
  const name = session.name?.trim() || sessionRef
  const space = session.spaceName ?? "No Space"
  const { preview, presentation } = card({ name, space })
  return {
    preview,
    presentation: {
      ...presentation,
      fields: [
        { label: "To", value: name },
        { label: "Space", value: space }
      ]
    },
    data: { reviewer: "user", session_id: session.sessionId }
  }
}
