import { ToolExecutionError } from "@arden-hq/loop"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { Effect } from "effect"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { toolFailure } from "./tool-failure.js"
import { ACTOR, type Actor, type RunAuthority } from "../execution/authority.js"
import { boundaryReach, refusalPath, type Path } from "../execution/decide.js"
import type { Refusal } from "../execution/refusal.js"
import { refusalError } from "./refusal.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const unknownSession = (sessionRef: string): ToolExecutionError =>
  new ToolExecutionError(
    UUID.test(sessionRef)
      ? `${sessionRef} is not a chat reference. A Memory page_ref is read with wiki_read_page; chat references come from session_list or session_search_transcripts.`
      : `No chat has the reference ${sessionRef}; it may have been deleted. Chat references come from session_list or session_search_transcripts. Do not retry it.`,
    { preview: "Chat not found", retryable: false }
  )

const SESSION_MISS = {
  other_space: "other_space",
  archived: "archived",
  unknown: "unknown"
} as const

type SessionMiss = (typeof SESSION_MISS)[keyof typeof SESSION_MISS]

type ActionMiss = Exclude<SessionMiss, typeof SESSION_MISS.unknown>

export type ChatVerb = "message" | "change" | "open"

export const otherSpaceReach = (input: {
  readonly authority: RunAuthority
  readonly verb: ChatVerb
  readonly handed: boolean
  readonly mode: ChatApprovalMode
  readonly approved: boolean
}): "allow" | "ask" | "deny" =>
  boundaryReach(
    input.authority,
    { kind: "chat", verb: input.verb, other_space: true, handed: input.handed },
    { mode: input.mode, approved: input.approved }
  )

const actionMiss = (sessionRef: string, miss: ActionMiss, actor: Actor): Refusal => {
  const read: Path = { kind: "tool", name: "session_read" }
  switch (miss) {
    case SESSION_MISS.other_space:
      return actor.kind === ACTOR.person
        ? {
            what: `Chat ${sessionRef} belongs to another Space. This chat can read it, open it, and send it a message (the user may have to approve it), but cannot change it; the user can, from that Space`,
            rule: "boundary",
            instead: [read, { kind: "ask_user" }]
          }
        : {
            what: `Chat ${sessionRef} belongs to another Space. This run can read it but cannot change, message or open it; only the user can, from their own chat`,
            rule: "boundary",
            instead: [read, ...refusalPath(actor)]
          }
    case SESSION_MISS.archived:
      return {
        what: `Chat ${sessionRef} was archived. It can still be read, but not changed, messaged or opened`,
        rule: "boundary",
        instead: [read]
      }
  }
}

export const sessionMiss = (
  queries: SessionQueries["Service"],
  sessionRef: string,
  signal: AbortSignal
): Promise<ActionMiss | typeof SESSION_MISS.unknown> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sessionId = yield* queries.sessionIdForRef(sessionRef)
      if (sessionId === null) return SESSION_MISS.unknown
      const header = yield* queries.loadHistoryHeader(sessionId)
      return header === null ? SESSION_MISS.unknown : SESSION_MISS.archived
    }).pipe(Effect.mapError((error) => toolFailure(error, "Session unavailable"))),
    { signal }
  )

export const unreachableSession = (
  sessionRef: string,
  miss: SessionMiss,
  actor: Actor
): ToolExecutionError => {
  if (miss === SESSION_MISS.unknown) return unknownSession(sessionRef)
  return refusalError(actionMiss(sessionRef, miss, actor))
}
