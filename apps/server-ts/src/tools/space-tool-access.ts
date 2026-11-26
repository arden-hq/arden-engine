import { ToolExecutionError } from "@arden-hq/loop"
import { Effect } from "effect"

import {
  SpaceStore,
  SpaceStoreError,
  spaceChoices,
  type PersistedSpace
} from "../persistence/spaces/store.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import { WorkStore } from "../persistence/work/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { toolFailure } from "./tool-failure.js"
import { Wiki } from "../wiki/service.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import type { ServerRunContext } from "./run-context.js"
import { loadSnapshot } from "./wiki-access.js"
import {
  WORK_REFUSAL_REASON,
  WORK_TARGET,
  WORK_TARGET_DECISION,
  workTarget,
  type WorkBoundaryReason
} from "./work-reach.js"
import { STORE_REASON } from "../persistence/errors.js"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { refusalError } from "./refusal.js"

export interface SpaceToolServices {
  readonly spaces: SpaceStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
  readonly work: WorkStore["Service"]
  readonly wiki: Wiki["Service"]
}

interface SpaceTarget {
  readonly space: PersistedSpace
}

export interface SpacePageTarget extends SpaceTarget {
  readonly snapshot: Snapshot
  readonly page: PageRecord
}

const sessionFailure = (cause: SessionQueryFailure): ToolExecutionError =>
  toolFailure(
    { reason: cause.reason, message: `Could not resolve the current Space: ${cause.message}` },
    "Space unavailable"
  )

export const spaceFailure = (error: SpaceStoreError): ToolExecutionError =>
  error.reason === STORE_REASON.conflict
    ? new ToolExecutionError(error.message, { preview: "Space changed", retryable: false })
    : toolFailure(error, "Space unavailable")

export const noSpace = async (
  services: { readonly spaces: SpaceStore["Service"] },
  requestedSpaceId: string | undefined,
  signal: AbortSignal
): Promise<ToolExecutionError> => {
  const spaces = await Effect.runPromise(
    services.spaces.list().pipe(Effect.mapError(spaceFailure)),
    {
      signal
    }
  )
  return new ToolExecutionError(
    `${
      requestedSpaceId === undefined
        ? "This Automation chat is in no Space, so name the Space."
        : `No active Space exists with id '${requestedSpaceId}'.`
    } ${spaceChoices(spaces)}`,
    {
      preview: requestedSpaceId === undefined ? "Space required" : "Space not found",
      retryable: false
    }
  )
}

export const resolveSpace = async (
  services: SpaceToolServices,
  run: ServerRunContext,
  requestedSpaceId: string | undefined,
  signal: AbortSignal,
  options: { readonly mutation: boolean }
): Promise<SpaceTarget> => {
  const header = await Effect.runPromise(
    services.sessions.loadHistoryHeader(run.sessionId).pipe(Effect.mapError(sessionFailure)),
    { signal }
  )
  const spaceId = options.mutation
    ? mutationSpace(run, header?.spaceId ?? undefined, requestedSpaceId)
    : (requestedSpaceId ?? header?.spaceId ?? undefined)
  if (spaceId === undefined) throw await noSpace(services, undefined, signal)
  const space = await Effect.runPromise(
    services.spaces.get(spaceId).pipe(Effect.mapError(spaceFailure)),
    { signal }
  )
  if (space === null) throw await noSpace(services, spaceId, signal)
  return { space }
}

const mutationSpace = (
  run: ServerRunContext,
  chatSpaceId: string | undefined,
  requestedSpaceId: string | undefined
): string | undefined => {
  const decision = workTarget({
    authority: run.authority,
    chatSpaceId,
    chatSessionId: run.sessionId,
    requestedSpaceId,
    op: "change"
  })
  if (decision.kind === WORK_TARGET_DECISION.target) {
    switch (decision.target.kind) {
      case WORK_TARGET.space:
        return decision.target.spaceId
      case WORK_TARGET.job:
        return decision.target.spaceId ?? chatSpaceId
      case WORK_TARGET.chat:
        return undefined
    }
  }
  if (decision.reason === WORK_REFUSAL_REASON.no_space) return undefined
  throw refusalError({
    what: PAGE_REFUSAL[decision.reason],
    rule: "boundary",
    instead: decision.instead
  })
}

const PAGE_REFUSAL: Record<WorkBoundaryReason, string> = {
  outside_job_space: "A job changes only its own Space's page",
  outside_delegated_space: "An agent changes only the page of the Space whose chat started it",
  unrecorded: "This run's authority was not recorded, so it cannot change a Space page"
}

export const resolveSpacePage = async (
  services: SpaceToolServices,
  run: ServerRunContext,
  requestedSpaceId: string | undefined,
  signal: AbortSignal,
  options: { readonly mutation: boolean }
): Promise<SpacePageTarget> => {
  const target = await resolveSpace(services, run, requestedSpaceId, signal, options)
  if (target.space.page_id === null || target.space.page_path === null) {
    throw new ToolExecutionError(`Space '${target.space.name}' has no attached Wiki page.`, {
      preview: "No Space page",
      retryable: false
    })
  }
  const snapshot = await loadSnapshot(services.wiki, signal)
  const page = snapshot.pages.find(
    (record) =>
      record.page.pageId === target.space.page_id &&
      record.page.lifecycle === WIKI_PAGE_LIFECYCLE.active
  )
  if (page === undefined) {
    throw new ToolExecutionError(
      `The Wiki page attached to Space '${target.space.name}' is missing.`,
      {
        preview: "Space page missing",
        retryable: false
      }
    )
  }
  return { ...target, snapshot, page }
}
