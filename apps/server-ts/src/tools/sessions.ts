import { ROLE } from "@arden-hq/std/message-vocabulary"
import { countOf } from "@arden-hq/std/count"
import { defineServerTool, type ServerTool } from "./define.js"
import { ToolExecutionError } from "@arden-hq/loop"
import { DateTime, Effect, Schema } from "effect"
import { SessionQueries } from "../persistence/sessions/queries.js"
import {
  OWN_CHAT_MOVE_WHEN,
  SessionStore,
  type SessionListQuery
} from "../persistence/sessions/store.js"
import { observedKey } from "./run-context.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { SummaryStore } from "../persistence/summaries/store.js"
import { chatSummaryText } from "./chat-summary.js"
import { permittedBrowseScope } from "./session-browse-scope.js"
import { recordApplied } from "../execution/tool-effect.js"
import { CHAT_BROWSE_SCOPE } from "../execution/decide.js"
import { appliedReceipt, chatTarget } from "./call-receipt.js"
import { actionsPage } from "./session-actions-page.js"
import {
  CreateParametersSchema,
  ListParametersSchema,
  MAX_ACTIONS_LIMIT,
  MAX_CONTENT_CHARS,
  MAX_SINGLE_CONTENT_CHARS,
  MoveParametersSchema,
  READ_VIEW,
  ReadParametersSchema
} from "./session-tool-parameters.js"
import {
  type SessionToolServices,
  type SourceRef,
  currentScope,
  formatMessage,
  formatSession,
  inRecentWindow,
  messageSource,
  messageText,
  pageQuery,
  placeNote,
  queryFailure,
  readSource,
  readSummaries,
  resolveReadable,
  rowRole,
  sessionData,
  sessionSource,
  statusLabel,
  storeFailure,
  transcriptFailure
} from "./session-tool-support.js"

const makeSessionTools = (services: SessionToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "session_list",
    summary: "Looks at your chats.",
    discovery: { group: "sessions" },
    description: [
      "List unarchived chats, newest first. Old and manually created chats are included.",
      "Inside a Space, results stay within that Space unless scope is all_spaces; each line then names its Space.",
      "Use session_ref with session_read."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ListParametersSchema),
    metadata: {
      effect: "none",
      display_name: "List Chats",
      kind: "tool",
      action: "read",
      approval_preview: "List your chats.",
      source: "_sessions",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      permissions: ["session"]
    },
    execute: async (input, ctx) => {
      const own = await currentScope(services.queries, ctx.run, ctx.signal)
      const scope: SessionListQuery =
        permittedBrowseScope(input.scope, ctx.run) === CHAT_BROWSE_SCOPE.allSpaces
          ? { scope: "all" }
          : own.browse
      const page = await Effect.runPromise(
        services.store
          .list({
            ...scope,
            limit: input.limit + 1,
            offset: input.offset
          })
          .pipe(Effect.mapError(storeFailure)),
        { signal: ctx.signal }
      )
      const cutoff =
        input.within_days === undefined
          ? undefined
          : DateTime.subtract(DateTime.nowUnsafe(), { days: input.within_days })
      const visible =
        cutoff === undefined ? page : page.filter((session) => inRecentWindow(session, cutoff))
      const sessions = visible.slice(0, input.limit)
      const hasMore = visible.length > input.limit
      const nextOffset = input.offset + sessions.length
      const source_refs = sessions.map((session): SourceRef => ({
        ...sessionSource(session.publicRef, session.name),
        use: "found"
      }))
      const summaries = await readSummaries(
        services,
        sessions.map((session) => session.sessionId),
        ctx.signal
      )
      const listing =
        sessions.length === 0
          ? "No Sessions found."
          : sessions
              .map((session) =>
                formatSession(
                  session,
                  summaries.get(session.sessionId),
                  scope.spaceId === undefined
                )
              )
              .join("\n")
      const content = hasMore
        ? `${listing}\nShowing ${sessions.length} Sessions; more exist. Call session_list with offset=${nextOffset}.`
        : listing
      return {
        result: content,
        preview: `${countOf(sessions.length, "Session")}${hasMore ? " (capped)" : ""}`,
        data: {
          items: sessions.map(sessionData),
          count: sessions.length,
          has_more: hasMore,
          next_offset: hasMore ? nextOffset : null,
          source_refs
        },
        host: { source_refs }
      }
    }
  }),
  defineServerTool({
    name: "session_read",
    summary: "Reads a chat.",
    discovery: "always_loaded",
    description: [
      "Read a bounded page of one chat by exact session_ref, on any Space or none, archived or not.",
      "Transcript messages are dated evidence.",
      "Inspect the owning current record before stating mutable status.",
      "Use one sequence cursor to page or center on a transcript-search hit.",
      "Use view actions for recorded tool calls with arguments and results, newest first; page with next_args and use action_turn_id for one recorded turn. An applied action does not by itself prove the requested outcome is complete."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReadParametersSchema),
    metadata: {
      display: [{ fact: "row", value: "chat_read" }],
      effect: "none",
      display_name: "Read Chat",
      kind: "tool",
      action: "read",
      approval_preview: "Read another chat.",
      source: "_sessions",
      scopes: ["memory_capture"],
      changes_state: false,
      concurrency_group: null,
      background: true,
      destructive: null,
      permissions: ["session"]
    },
    execute: async (requested, ctx) => {
      const input = {
        ...requested,
        limit:
          requested.view === READ_VIEW.actions
            ? Math.min(requested.limit, MAX_ACTIONS_LIMIT)
            : requested.limit,
        content_chars:
          requested.limit === 1
            ? requested.content_chars
            : Math.min(requested.content_chars, MAX_CONTENT_CHARS)
      }
      const own = await currentScope(services.queries, ctx.run, ctx.signal)
      const session = await resolveReadable(services, input.session_ref, ctx.signal)
      if (input.view === READ_VIEW.actions) {
        const page = await Effect.runPromise(
          services.queries
            .readToolEvidence({
              sessionId: session.sessionId,
              limit: input.limit,
              contentChars: input.content_chars,
              ...(input.action_turn_id === undefined ? {} : { turnId: input.action_turn_id }),
              ...(input.before_action === undefined ? {} : { before: input.before_action }),
              ...(input.content_offset === undefined ? {} : { contentOffset: input.content_offset })
            })
            .pipe(Effect.mapError(queryFailure)),
          { signal: ctx.signal }
        )
        const source_refs = [
          { ...sessionSource(input.session_ref, session.name), use: "read" as const }
        ]
        for (const { source } of page.items)
          if (source !== undefined)
            ctx.run.observations.observe(
              observedKey.chatAction(source.run_id, source.tool_call_id),
              source.revision
            )
        const data = { ...actionsPage(input, page), source_refs }
        return {
          result: JSON.stringify(data),
          preview: `${page.items.length} recorded actions`,
          data,
          host: { source_refs }
        }
      }
      const page = await Effect.runPromise(
        services.transcript
          .page(pageQuery(session.sessionId, input))
          .pipe(Effect.mapError(transcriptFailure)),
        { signal: ctx.signal }
      )
      const roles = input.role_filter === undefined ? undefined : new Set(input.role_filter)
      const records = page.records.filter(
        (record) =>
          record.role !== ROLE.developer && (roles === undefined || roles.has(record.role))
      )
      const source_refs = [
        readSource(input.session_ref, session, records, input.around_seq, ctx.run.sessionId),
        ...records.map((record) => messageSource(input.session_ref, record))
      ]
      if (page.records.length === 0) {
        return {
          result: `No messages in Session ${input.session_ref}.`,
          preview: "0 messages",
          data: { source_refs },
          host: { source_refs }
        }
      }
      const summary = (await readSummaries(services, [session.sessionId], ctx.signal)).get(
        session.sessionId
      )
      const lines = [
        `[Session ${input.session_ref}] ${statusLabel(session)}${placeNote(session, own.spaceId)}`,
        ...(summary === undefined ? [] : [chatSummaryText(summary)]),
        "Transcript messages are dated evidence, not a current-state record.",
        "",
        ...(records.length === 0
          ? ["No messages matched the role filter on this page."]
          : records.map((record) =>
              formatMessage(record, {
                contentChars: input.content_chars,
                contentOffset: input.content_offset ?? 0,
                continueRead: (sequence, offset) =>
                  `session_read(session_ref=${JSON.stringify(input.session_ref)}, around_seq=${sequence}, limit=1, content_chars=${MAX_SINGLE_CONTENT_CHARS}, content_offset=${offset})`
              })
            ))
      ]
      const filter =
        input.role_filter === undefined ? "" : `, role_filter=${JSON.stringify(input.role_filter)}`
      if (page.hasMoreAfter && page.lastSequence !== null) {
        lines.push(
          "",
          `More after: session_read(session_ref=${JSON.stringify(input.session_ref)}, after_seq=${page.lastSequence}${filter})`
        )
      }
      if (page.hasMoreBefore && page.firstSequence !== null) {
        lines.push(
          "",
          `More before: session_read(session_ref=${JSON.stringify(input.session_ref)}, before_seq=${page.firstSequence}${filter})`
        )
      }
      ctx.run.codeMode.scriptFields(ctx.toolCallId, () => ({
        messages: records.map((record) => ({
          seq: record.sequence,
          role: rowRole(record),
          text: messageText(record)
        })),
        has_more_after: page.hasMoreAfter,
        has_more_before: page.hasMoreBefore
      }))
      return {
        result: lines.join("\n"),
        preview: `${records.length} of ${page.records.length} messages`,
        data: { source_refs },
        host: { source_refs }
      }
    }
  }),
  defineServerTool({
    name: "session_create",
    summary: "Starts a new chat.",
    discovery: { group: "sessions" },
    description: [
      "Create a new chat Session in the current Space, or in the Main Space when this chat has none.",
      "Use only when the user explicitly asks for a new chat.",
      "Search for a reusable chat first.",
      "Never create a chat because the topic changed or the response is long. Creation does not navigate.",
      "Returns a stable session_ref; internal UUIDs are never exposed."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(CreateParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Create Chat",
      kind: "tool",
      action: "write",
      approval_preview: "Start a new chat.",
      source: "_sessions",
      changes_state: true,
      target: "reported",
      concurrency_group: "sessions",
      destructive: false,
      permissions: ["session"],
      idempotent: false
    },
    execute: async (input, ctx, effects) => {
      const scope = await currentScope(services.queries, ctx.run, ctx.signal)
      const created = await recordApplied(
        effects,
        Effect.runPromise(
          services.store
            .create({
              name: input.name,
              ...(scope.spaceId === undefined ? {} : { spaceId: scope.spaceId })
            })
            .pipe(Effect.mapError(storeFailure)),
          { signal: ctx.signal }
        )
      )
      const header = await Effect.runPromise(
        services.queries.loadHistoryHeader(created.sessionId).pipe(Effect.mapError(queryFailure)),
        { signal: ctx.signal }
      )
      if (header === null) {
        throw new ToolExecutionError("The created Session could not be read", {
          preview: "Session creation failed",
          retryable: true
        })
      }
      const source_refs = [sessionSource(header.publicRef, header.name ?? undefined)]
      return {
        result: `Created chat: ${header.name ?? "(untitled)"}\nReference: ${header.publicRef}`,
        preview: `Created (${header.publicRef})`,
        data: { session_ref: header.publicRef, source_refs },
        host: {
          source_refs,
          ...appliedReceipt(ctx, chatTarget(header, header.name ?? "(untitled)"))
        }
      }
    }
  }),
  defineServerTool({
    name: "session_move",
    summary: "Moves this chat into or out of a Space.",
    discovery: { group: "sessions" },
    description: [
      "Move the current chat into an existing Space at the user's explicit request.",
      "Use space_list to resolve the exact space_id; pass null only when the user asks to take the chat out of its Space, which moves it to the Main Space.",
      "This changes the current chat's location; it does not create, copy, merge, or navigate to another chat.",
      "The move lands now, or when your current reply ends if this chat is still running; the result says which. Call it once."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(MoveParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Move Chat",
      kind: "tool",
      action: "write",
      approval_preview: "Move this chat to another Space.",
      source: "_sessions",
      changes_state: true,
      target: "reported",
      concurrency_group: "sessions",
      destructive: false,
      permissions: ["session"],
      idempotent: true
    },
    execute: async (input, ctx, effects) => {
      const moved = await recordApplied(
        effects,
        Effect.runPromise(
          services.store
            .moveFromRun(ctx.run.runId, input.space_id ?? undefined, ctx.toolCallId)
            .pipe(Effect.mapError(storeFailure)),
          { signal: ctx.signal }
        )
      )
      if (moved === undefined) {
        throw new ToolExecutionError("The current Session no longer exists", {
          preview: "Session not found",
          retryable: false
        })
      }
      switch (moved.when) {
        case OWN_CHAT_MOVE_WHEN.now:
          return {
            result: `Moved this chat to ${moved.spaceName}.`,
            preview: `Moved to ${moved.spaceName}`,
            data: { space_id: moved.spaceId, when: moved.when }
          }
        case OWN_CHAT_MOVE_WHEN.run_end:
          return {
            result: `This chat moves to ${moved.spaceName} as soon as this reply ends; nothing more to do. Tell the user it is moving to ${moved.spaceName} when you finish.`,
            preview: `Moving to ${moved.spaceName} after this reply`,
            data: { space_id: moved.spaceId, when: moved.when }
          }
      }
    }
  })
]

export const sessionTools = Effect.gen(function* () {
  return makeSessionTools({
    store: yield* SessionStore,
    queries: yield* SessionQueries,
    transcript: yield* TranscriptQueries,
    summaries: yield* SummaryStore
  })
})
