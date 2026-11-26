import { ToolExecutionError } from "@arden-hq/loop"
import type { NavigationRequestedEvent } from "@arden-hq/protocol"
import { NAVIGATION_ASKED_BY } from "@arden-hq/protocol/common"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { ToolExecutionStore } from "../persistence/tools/store.js"
import { WorkStore } from "../persistence/work/store.js"
import { Wiki } from "../wiki/service.js"
import { handedCapture, readCapture } from "../persistence/sessions/capture.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt, chatTarget } from "./call-receipt.js"
import { chatHandoff } from "./chat-handoff.js"
import { placeResource } from "./app-destination.js"
import { resolveDestination } from "./app-open-destination.js"
import {
  AppOpenParametersSchema,
  ArchiveParametersSchema,
  ForwardMessageParametersSchema,
  RenameParametersSchema,
  SendMessageParametersSchema
} from "./session-action-parameters.js"
import {
  type SessionActionToolServices,
  type SourceRef,
  eventFailure,
  findSession,
  otherSpaceCard,
  resolveSession,
  sessionFailure,
  sessionQueryFailure
} from "./session-action-access.js"
import { deliverToSession, handedOver } from "./session-action-delivery.js"

const archivePreview = (archived: number, summary: string, current: boolean): string => {
  if (!current) return archived === 0 ? "Nothing archived" : summary
  return archived === 0 ? "Archives this chat when done" : `${summary} This chat when done.`
}

const sourceRef = (sessionRef: string, name: string | undefined): SourceRef => ({
  provider: "arden",
  kind: "session",
  ref: sessionRef,
  title: name?.trim() || sessionRef
})

const hasConnectionChoiceInRun = async (
  services: SessionActionToolServices,
  sessionId: string,
  runId: string,
  signal: AbortSignal
): Promise<boolean> => {
  const results = await Effect.runPromise(
    services.executions
      .priorResults({ sessionId, toolName: "capability_propose" })
      .pipe(Effect.catch(() => Effect.succeed([]))),
    { signal }
  )
  return results.some(
    (result) =>
      result.runId === runId &&
      Array.isArray(result.data["candidates"]) &&
      result.data["candidates"].length > 0
  )
}

const makeSessionActionTools = (services: SessionActionToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "session_send_message",
    summary: "Sends a message to another chat.",
    discovery: { group: "sessions" },
    description: [
      "Deliver one self-contained message to another active Session by exact session_ref.",
      "It reads there as your handoff from this chat, under a link to this chat; name chats by their titles, never by session_ref.",
      "A running target receives it at the next model-step boundary; an idle target starts a new run. Returns immediately. Asks by default."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(SendMessageParametersSchema),
    metadata: {
      display: [{ fact: "result", value: "chat_sent" }],
      effect: "arden_db",
      display_name: "Send Message",
      kind: "tool",
      action: "execute",
      approval_preview: "Send a message to another chat.",
      source: "_sessions",
      presentation: "conversation",
      changes_state: true,
      concurrency_group: "sessions",
      destructive: true,
      open_world: true,
      idempotent: false,
      default_approval: "ask",
      permissions: ["session"],
      requirement: "boundary",
      target: "reported"
    },
    approvalPrompt: (input) => ({
      presentation: {
        title: "Send this message?",
        fields: [{ label: "To", value: input.session_ref }],
        body: { label: "Message", text: input.message }
      }
    }),
    approvalRequirement: (input, ctx) =>
      otherSpaceCard(services, ctx, "session_send_message", input.session_ref, false, (target) => ({
        preview: `Send a message to ${target.name} on another Space`,
        presentation: {
          title: "Send this message to a chat on another Space?",
          body: { label: "Message", text: input.message }
        }
      })),
    execute: async (input, ctx, effects) => {
      const source = await Effect.runPromise(
        services.queries
          .loadHistoryHeader(ctx.run.sessionId)
          .pipe(Effect.mapError(sessionQueryFailure)),
        { signal: ctx.signal }
      )
      if (source === null) throw new ToolExecutionError("This chat's identity is unavailable")
      const { target, receipt } = await recordApplied(
        effects,
        deliverToSession(services, ctx, "session_send_message", input.session_ref, false, (to) =>
          chatHandoff({
            source,
            targetRef: to.publicRef,
            message: input.message,
            clientId: `session-send:${ctx.run.runId}:${ctx.toolCallId}`,
            toolCallId: ctx.toolCallId
          })
        )
      )
      const ref = sourceRef(input.session_ref, target.name)
      const name = target.name?.trim() || input.session_ref
      return {
        result: `Delivered to ${name} (${input.session_ref}). The reply appears in that Session.`,
        preview: `Sent to ${name}`,
        data: { session_ref: input.session_ref, status: receipt.status, source_refs: [ref] },
        host: { source_refs: [ref], ...appliedReceipt(ctx, chatTarget(target, name)) }
      }
    }
  }),
  defineServerTool({
    name: "forward_message",
    summary: "Forwards what you handed over into the chat it belongs to.",
    discovery: { group: "sessions" },
    description: [
      "Forward this chat's first message, unchanged, into the chat it belongs to, by exact session_ref",
      "from session_list: a capture the user handed over (screenshot and note) arrives there as the",
      "user's own message, and that chat answers it; this chat closes once your answer ends.",
      "Only in a chat made to route what the user handed over; the chat may be on any Space."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ForwardMessageParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Forward Message",
      kind: "tool",
      action: "write",
      approval_preview: "Forward the user's message into another chat.",
      source: "_sessions",
      changes_state: true,
      target: "reported",
      concurrency_group: "sessions",
      destructive: false,
      idempotent: true,
      default_approval: "approve",
      permissions: ["session"],
      requirement: "boundary"
    },
    approvalRequirement: async (input, ctx) => {
      const capture = await Effect.runPromise(
        services.queries.loadCapture(ctx.run.sessionId).pipe(Effect.mapError(sessionQueryFailure)),
        { signal: ctx.signal }
      )
      const handed = handedOver(capture)
      return otherSpaceCard(
        services,
        ctx,
        "forward_message",
        input.session_ref,
        handed,
        (target) => ({
          preview: `Forward this to ${target.name} on another Space`,
          presentation: {
            title: "Forward this to a chat on another Space?",
            approve_label: "Forward"
          }
        })
      )
    },
    execute: async (input, ctx, effects) => {
      const current = await Effect.runPromise(
        services.queries.load(ctx.run.sessionId).pipe(Effect.mapError(sessionQueryFailure)),
        { signal: ctx.signal }
      )
      const capture = current === null ? undefined : readCapture(current.metadata)
      const handed = current === null ? undefined : handedCapture(current.messages)
      if (capture === undefined || handed === undefined || handed.images.length === 0) {
        throw new ToolExecutionError(
          "forward_message works only in a chat made to route what the user handed over",
          {
            preview: "Nothing to forward",
            retryable: false
          }
        )
      }
      const clientId = `capture:${ctx.run.sessionId}`
      const { target } = await recordApplied(
        effects,
        deliverToSession(
          services,
          ctx,
          "forward_message",
          input.session_ref,
          handedOver(capture),
          () => ({ clientId, message: handed.note, images: handed.images })
        )
      )
      const name = target.name?.trim() || input.session_ref
      const forwarded = {
        session_id: target.sessionId,
        session_ref: input.session_ref,
        name,
        client_id: clientId
      }
      await recordApplied(
        effects,
        Effect.runPromise(
          services.store
            .saveCaptureForward(ctx.run.sessionId, forwarded)
            .pipe(Effect.mapError(sessionFailure)),
          { signal: ctx.signal }
        )
      )
      await Effect.runPromise(
        services.store
          .archiveWhenIdle(ctx.run.sessionId, { runId: ctx.run.runId, toolCallId: ctx.toolCallId })
          .pipe(Effect.mapError(sessionFailure)),
        { signal: ctx.signal }
      )
      const ref = sourceRef(input.session_ref, target.name)
      return {
        result: `Forwarded into ${name} (${input.session_ref}); that chat answers it. End with one sentence for the user: what it is and that it went to ${name}.`,
        preview: `Forwarded to ${name}`,
        data: { forwarded, source_refs: [ref] },
        host: { source_refs: [ref], ...appliedReceipt(ctx, chatTarget(target, name)) }
      }
    }
  }),
  defineServerTool({
    name: "session_rename",
    summary: "Renames a chat.",
    discovery: { group: "sessions" },
    description: "Rename one active Session by exact session_ref. The sidebar updates durably.",
    parameters: Schema.toStandardSchemaV1(RenameParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Rename Chat",
      kind: "tool",
      action: "write",
      approval_preview: "Rename a chat.",
      source: "_sessions",
      changes_state: true,
      target: "reported",
      concurrency_group: "sessions",
      destructive: false,
      idempotent: true,
      permissions: ["session"]
    },
    execute: async (input, ctx, effects) => {
      const target = await resolveSession(
        services,
        { run: ctx.run, tool: "session_rename", verb: "change", handed: false },
        input.session_ref,
        ctx.signal
      )
      const renamed = await recordApplied(
        effects,
        Effect.runPromise(
          services.store
            .rename(target.sessionId, input.name, {
              runId: ctx.run.runId,
              toolCallId: ctx.toolCallId
            })
            .pipe(Effect.mapError(sessionFailure)),
          { signal: ctx.signal }
        )
      )
      if (renamed === undefined) {
        throw new ToolExecutionError(`Session ${input.session_ref} disappeared before rename`, {
          preview: "Session not found",
          retryable: true
        })
      }
      const ref = sourceRef(input.session_ref, input.name)
      return {
        result: `Renamed ${input.session_ref}: ${target.name?.trim() || "(untitled)"} → ${input.name}.`,
        preview: `Renamed to ${input.name}`,
        data: { session_ref: input.session_ref, name: input.name, source_refs: [ref] },
        host: { source_refs: [ref] }
      }
    }
  }),
  defineServerTool({
    name: "session_archive",
    summary: "Archives chats.",
    discovery: { group: "sessions" },
    description: [
      "Archive active Sessions by exact session_ref. Inside a Space, only that Space's chats can be archived; others are reported as not found.",
      "The current Session is archived once this turn and its agents finish, unless the user writes to it first. Skipped and reported: a Session with a live run, and this chat when archiving it would delete its Automations. Every requested ref is reported; restore from Settings → Archive."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ArchiveParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Archive Chats",
      kind: "tool",
      action: "write",
      approval_preview: "Archive chats.",
      source: "_sessions",
      changes_state: true,
      target: "reported",
      concurrency_group: "sessions",
      destructive: false,
      idempotent: true,
      permissions: ["session"]
    },
    execute: async (input, ctx, effects) => {
      const requested = [...new Set(input.session_refs)]
      const lines: Array<string> = []
      let archived = 0
      let current = false
      for (const sessionRef of requested) {
        const target = await findSession(services, ctx.run.sessionId, sessionRef, ctx.signal)
        if (target === undefined) {
          lines.push(`- ${sessionRef} · skipped — not active or not found`)
          continue
        }
        if (target.sessionId === ctx.run.sessionId) {
          const wish = await recordApplied(
            effects,
            Effect.runPromise(
              services.store
                .archiveWhenIdle(target.sessionId, {
                  runId: ctx.run.runId,
                  toolCallId: ctx.toolCallId
                })
                .pipe(Effect.mapError(sessionFailure)),
              { signal: ctx.signal }
            )
          )
          current = wish.kind === "kept"
          const name = target.name?.trim() || "(untitled)"
          if (wish.kind === "kept")
            lines.push(`- ${sessionRef} · archives when this turn and its agents finish — ${name}`)
          else if (wish.kind === "automations")
            lines.push(
              `- ${sessionRef} · skipped — archiving would delete its Automations (${wish.names.join(", ")}); ask the user first`
            )
          else lines.push(`- ${sessionRef} · skipped — Session changed`)
          continue
        }
        if (target.activeRun !== undefined) {
          lines.push(`- ${sessionRef} · skipped — live run in progress`)
          continue
        }
        const result = await recordApplied(
          effects,
          Effect.runPromise(
            services.store
              .archive(target.sessionId, { runId: ctx.run.runId, toolCallId: ctx.toolCallId })
              .pipe(Effect.mapError(sessionFailure)),
            { signal: ctx.signal }
          )
        )
        if (!result) {
          lines.push(`- ${sessionRef} · skipped — Session changed`)
          continue
        }
        archived += 1
        lines.push(`- ${sessionRef} · archived — ${target.name?.trim() || "(untitled)"}`)
      }
      const summary = `Archived ${archived} of ${requested.length}.`
      return {
        result: [
          summary,
          ...(current
            ? [
                "This chat is archived when this turn and its agents finish; a new message from the user keeps it open."
              ]
            : []),
          "Restore them from Settings → Archive.",
          ...lines
        ].join("\n"),
        preview: archivePreview(archived, summary, current),
        data: { archived, requested: requested.length, archives_when_done: current }
      }
    }
  }),
  defineServerTool({
    name: "app_open",
    summary: "Opens a place in Arden for you.",
    discovery: { group: "arden_settings" },
    description: [
      "Offer or open a current Arden destination: Home, Session, Settings, Automation, Task, Memory, or Space.",
      "mode offer (default) shows a card the user may open; mode open moves the user now and is only for when they asked to be taken there.",
      "References are validated before one durable navigation request is emitted.",
      "Do not open Settings after capability_propose; its inline connection choice owns that decision."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(AppOpenParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Open in Arden",
      kind: "tool",
      action: "write",
      approval_preview: "Open a place in Arden.",
      source: "_app",
      presentation: "conversation",
      changes_state: true,
      target: "reported",
      concurrency_group: "app_navigation",
      destructive: false,
      idempotent: false,
      permissions: ["session"]
    },
    execute: async (input, ctx, effects) => {
      if (
        input.destination.kind === "settings" &&
        (await hasConnectionChoiceInRun(services, ctx.run.sessionId, ctx.run.runId, ctx.signal))
      ) {
        effects.unchanged()
        return {
          result:
            "The connection choice is already visible in chat. Wait for the user to choose it.",
          preview: "Choice pending in chat",
          data: { opened: false, reason: "connection_choice_pending" }
        }
      }
      const destination = await resolveDestination(
        services,
        input.destination,
        async (sessionRef) =>
          (
            await resolveSession(
              services,
              { run: ctx.run, tool: "app_open", verb: "open", handed: false },
              sessionRef,
              ctx.signal
            )
          ).sessionId,
        ctx.signal
      )
      const mode = input.mode ?? "offer"
      const event: NavigationRequestedEvent = {
        type: "navigation_requested",
        origin_session_id: ctx.run.sessionId,
        destination,
        label: input.label,
        mode,
        asked_by: { kind: NAVIGATION_ASKED_BY.tool_call, tool_call_id: ctx.toolCallId }
      }
      await recordApplied(
        effects,
        Effect.runPromise(services.events.appendEvent(event).pipe(Effect.mapError(eventFailure)), {
          signal: ctx.signal
        })
      )
      return {
        result:
          mode === "open"
            ? `Asked Arden to open: ${input.label}.`
            : `Offered in chat: ${input.label}. The user opens it if they want to.`,
        preview: input.label,
        data: { navigation: { destination: input.destination, label: input.label } },
        host: appliedReceipt(ctx, placeResource(input.destination, input.label))
      }
    }
  })
]

export const sessionActionTools = Effect.gen(function* () {
  return makeSessionActionTools({
    store: yield* SessionStore,
    queries: yield* SessionQueries,
    automations: yield* AutomationCatalog,
    spaces: yield* SpaceStore,
    work: yield* WorkStore,
    wiki: yield* Wiki,
    events: yield* SessionLifecycleEvents,
    executions: yield* ToolExecutionStore
  })
})
