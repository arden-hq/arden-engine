import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isWrittenByPerson } from "../persistence/transcript/model.js"
import {
  authoredText,
  compactAnswerBlocks,
  evidenceText
} from "../persistence/transcript/content.js"
import { ToolExecutionError } from "@arden-hq/loop"
import { END_KIND, endKindOf } from "@arden-hq/protocol/runs"
import { STORE_REASON } from "../persistence/errors.js"
import { DateTime, Effect, Predicate } from "effect"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import {
  SessionStore,
  SessionStoreError,
  type SessionListEntry,
  type SessionListQuery
} from "../persistence/sessions/store.js"
import { toolFailure } from "./tool-failure.js"
import type {
  TranscriptMessageRecord,
  TranscriptPageQuery
} from "../persistence/transcript/model.js"
import {
  TranscriptQueries,
  type TranscriptQueryFailure
} from "../persistence/transcript/queries.js"
import { passage, type SourcePassage } from "./source-passage.js"
import { SummaryStore, type ChatSummary } from "../persistence/summaries/store.js"
import { chatSummaryText } from "./chat-summary.js"
import { unknownSession } from "./session-visibility.js"
import { seesEveryChat, spaceLabel } from "./session-browse-scope.js"
import type { ServerRunContext } from "./run-context.js"
import { eventRowText } from "../persistence/transcript/chat-events.js"
import { chatTarget } from "./call-receipt.js"
import { ReadParametersSchema } from "./session-tool-parameters.js"
import { SESSION_TYPE, type SessionType } from "@arden-hq/protocol/sessions"
import { type RuntimeRunStatus } from "@arden-hq/protocol"

export interface SessionToolServices {
  readonly store: SessionStore["Service"]
  readonly queries: SessionQueries["Service"]
  readonly transcript: TranscriptQueries["Service"]
  readonly summaries: SummaryStore["Service"]
}

export const readSummaries = (
  services: SessionToolServices,
  sessionIds: ReadonlyArray<string>,
  signal: AbortSignal
): Promise<ReadonlyMap<string, ChatSummary>> =>
  Effect.runPromise(
    services.summaries
      .chats(sessionIds)
      .pipe(Effect.orElseSucceed((): ReadonlyMap<string, ChatSummary> => new Map())),
    { signal }
  )

export interface SourceRef extends Partial<SourcePassage> {
  readonly provider: "arden"
  readonly kind: "session" | "message"
  readonly ref: string
  readonly title: string
  readonly within?: string
}

const storeFailurePreview = (error: SessionStoreError): string => {
  switch (error.reason) {
    case STORE_REASON.invalid:
      return "Invalid session request"
    case STORE_REASON.not_found:
      return "Session not found"
    case STORE_REASON.conflict:
      return "Session changed"
    case STORE_REASON.storage:
      return "Sessions unavailable"
  }
}

export const storeFailure = (error: SessionStoreError): ToolExecutionError =>
  toolFailure(error, storeFailurePreview(error))

export const queryFailure = (error: SessionQueryFailure): ToolExecutionError =>
  toolFailure(
    error,
    error.reason === STORE_REASON.corrupt ? "Session data is corrupt" : "Session unavailable"
  )

export const transcriptFailure = (error: TranscriptQueryFailure): ToolExecutionError =>
  toolFailure(
    error,
    error.reason === STORE_REASON.corrupt ? "Transcript data is corrupt" : "Transcript unavailable"
  )

interface CurrentScope {
  readonly spaceId: string | undefined
  readonly browse: SessionListQuery
}

export const currentScope = async (
  queries: SessionQueries["Service"],
  run: Pick<ServerRunContext, "sessionId" | "authority">,
  signal: AbortSignal
): Promise<CurrentScope> => {
  const header = await Effect.runPromise(
    queries.loadHistoryHeader(run.sessionId).pipe(Effect.mapError(queryFailure)),
    { signal }
  )
  if (header === null) {
    throw new ToolExecutionError("The current Session no longer exists", {
      preview: "Session not found",
      retryable: false
    })
  }
  return {
    spaceId: header.spaceId ?? undefined,
    browse: {
      scope: "all",
      ...(header.spaceId === null || seesEveryChat(header, run) ? {} : { spaceId: header.spaceId })
    }
  }
}

export const sessionSource = (sessionRef: string, name: string | undefined): SourceRef => ({
  provider: "arden",
  kind: "session",
  ref: sessionRef,
  title: name?.trim() || sessionRef
})

export const messageSource = (sessionRef: string, record: TranscriptMessageRecord): SourceRef => ({
  provider: "arden",
  kind: "message",
  ref: `${sessionRef}:${record.sequence}`,
  title: `${sessionRef} message ${record.sequence}`,
  within: sessionRef,
  use: "read"
})

export const statusLabel = (session: SessionListEntry): string => {
  const status = session.latestRun?.status
  if (session.activeRun !== undefined) {
    if (session.pendingApprovalsCount > 0) return "needs approval"
    return status ?? "running"
  }
  switch (endKindOf(status)) {
    case END_KIND.failed:
      return "failed"
    case END_KIND.stopped:
    case END_KIND.restart:
      return "stopped"
    case END_KIND.finished:
    case END_KIND.needsReview:
    case undefined:
      return "idle"
  }
}

export const formatSession = (
  session: SessionListEntry,
  summary: ChatSummary | undefined,
  labelSpace: boolean
): string => {
  const ref = session.publicRef
  const name = session.name?.trim() || "(untitled)"
  const kind = session.sessionType === SESSION_TYPE.chat ? "" : ` [${session.sessionType}]`
  const space = labelSpace ? ` · ${spaceLabel(session.spaceName)}` : ""
  const line = `- ${ref} · ${name}${kind}${space} · ${session.lastActivity} · ${session.messageCount} msgs · ${statusLabel(session)}`
  return summary === undefined ? line : `${line}\n  ${chatSummaryText(summary)}`
}

export type SessionData = {
  readonly session_ref: string
  readonly name: string | null
  readonly session_type: SessionType
  readonly space: string | null
  readonly last_activity: string
  readonly message_count: number
  readonly run_status: RuntimeRunStatus | null
  readonly is_active: boolean
}

export const sessionData = (session: SessionListEntry): SessionData => ({
  session_ref: session.publicRef,
  name: session.name ?? null,
  session_type: session.sessionType,
  space: session.spaceName ?? null,
  last_activity: session.lastActivity,
  message_count: session.messageCount,
  run_status: session.latestRun?.status ?? null,
  is_active: session.activeRun !== undefined
})

export const inRecentWindow = (session: SessionListEntry, cutoff: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(session.lastActivity)) >=
  DateTime.toEpochMillis(cutoff)

export const resolveReadable = async (
  services: SessionToolServices,
  sessionRef: string,
  signal: AbortSignal
): Promise<SessionListEntry> => {
  const matches = await Effect.runPromise(
    services.store
      .list({ scope: "all", sessionRef, includeArchived: true, limit: 1 })
      .pipe(Effect.mapError(storeFailure)),
    { signal }
  )
  if (matches[0] !== undefined) return matches[0]
  throw unknownSession(sessionRef)
}

export const placeNote = (session: SessionListEntry, ownSpaceId: string | undefined): string => {
  const elsewhere =
    session.spaceId === ownSpaceId ? [] : [`on ${spaceLabel(session.spaceName)}, not this chat's`]
  const archived = session.archivedAt === undefined ? [] : ["archived"]
  return [...elsewhere, ...archived].map((note) => ` · ${note}`).join("")
}

const messageToolName = (envelope: Readonly<Record<string, unknown>>): string | undefined => {
  if (Predicate.isString(envelope.name)) return envelope.name
  return Predicate.isString(envelope.tool_name) ? envelope.tool_name : undefined
}

export const rowRole = (record: TranscriptMessageRecord): string => {
  const name = messageToolName(record.envelope)
  return record.role === ROLE.tool && name !== undefined ? `${record.role}(${name})` : record.role
}

export const messageText = (record: TranscriptMessageRecord): string => {
  const envelope: Readonly<Record<string, unknown>> = record.envelope
  return (eventRowText(envelope) ?? compactAnswerBlocks(evidenceText(envelope.content))).trim()
}

export const formatMessage = (
  record: TranscriptMessageRecord,
  view: {
    readonly contentChars: number
    readonly contentOffset: number
    readonly continueRead: (sequence: number, offset: number) => string
  }
): string => {
  const envelope: Readonly<Record<string, unknown>> = record.envelope
  const event = eventRowText(envelope)
  const full = messageText(record)
  const start = Math.min(view.contentOffset, full.length)
  const end = Math.min(full.length, start + view.contentChars)
  const body = full.slice(start, end)
  const role = event === undefined ? rowRole(record) : "event"
  const line =
    body.length === 0 ? `#${record.sequence} [${role}]` : `#${record.sequence} [${role}] ${body}`
  if (end >= full.length) return line
  // oxlint-disable-next-line arden/restricted-owner -- a window over the message, naming the call that reads on; not a cut of its own
  return `${line}\n[truncated: shown ${start === 0 ? "" : `${start}-`}${end} of ${full.length} chars; continue with ${view.continueRead(record.sequence, end)}]`
}

const turnRefOf = (record: TranscriptMessageRecord): string =>
  Predicate.isString(record.envelope.turn_id) ? record.envelope.turn_id : record.messageId

const writtenText = (record: TranscriptMessageRecord): string | undefined => {
  const envelope = record.envelope
  if (!isWrittenByPerson(envelope) && record.role !== ROLE.assistant) return undefined
  const text = compactAnswerBlocks(authoredText(envelope.content))
  const quoted = passage(text)
  return quoted !== undefined && quoted.length >= 40 ? quoted : undefined
}

export const readSource = (
  sessionRef: string,
  session: SessionListEntry,
  records: ReadonlyArray<TranscriptMessageRecord>,
  around: number | undefined,
  requestingSessionId: string
): SourceRef => {
  const written = records.flatMap((record) => {
    const text = writtenText(record)
    return text === undefined ? [] : [{ record, text }]
  })
  const centred =
    around === undefined
      ? undefined
      : [...written].sort(
          (a, b) => Math.abs(a.record.sequence - around) - Math.abs(b.record.sequence - around)
        )[0]
  const chosen =
    centred ??
    [...written].reverse().find((entry) => entry.record.role === ROLE.assistant) ??
    written.at(-1)
  const turn = chosen === undefined ? undefined : turnRefOf(chosen.record)
  return {
    ...sessionSource(sessionRef, session.name),
    use: session.parentSessionId === requestingSessionId ? "work" : "read",
    href: chatTarget(
      { ...session, publicRef: sessionRef, ...(turn === undefined ? {} : { turnId: turn }) },
      session.name ?? "Chat"
    ).href,
    ...(chosen === undefined
      ? {}
      : { excerpt: chosen.text, at: DateTime.formatIso(chosen.record.createdAt) })
  }
}

export const pageQuery = (
  sessionId: string,
  input: typeof ReadParametersSchema.Type
): TranscriptPageQuery => {
  if (input.after_seq !== undefined) {
    return { _tag: "After", sessionId, limit: input.limit, sequence: input.after_seq }
  }
  if (input.before_seq !== undefined) {
    return { _tag: "Before", sessionId, limit: input.limit, sequence: input.before_seq }
  }
  if (input.around_seq !== undefined) {
    return { _tag: "Around", sessionId, limit: input.limit, sequence: input.around_seq }
  }
  return { _tag: "Latest", sessionId, limit: input.limit }
}
