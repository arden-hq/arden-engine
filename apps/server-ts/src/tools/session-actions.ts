import { ToolExecutionError, type ToolApprovalContext, type ToolContext } from "@arden-hq/loop"
import type { AppDestination, NavigationRequestedEvent } from "@arden-hq/protocol"
import type { ApprovalPresentation, ChatReceipt } from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { type AutomationStoreError } from "../persistence/automations/store.js"
import { SpaceStore, type SpaceStoreError } from "../persistence/spaces/store.js"
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
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { toolFailure } from "./tool-failure.js"
import {
  otherSpaceReach,
  sessionMiss,
  unreachableSession,
  type ChatVerb
} from "./session-visibility.js"
import type { WikiError } from "../wiki/errors.js"
import { Wiki } from "../wiki/service.js"
import { errorMessage } from "@arden-hq/std/errors"
import { handedCapture, readCapture, type StoredCapture } from "../persistence/sessions/capture.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt, chatTarget } from "./call-receipt.js"
import { chatHandoff } from "./chat-handoff.js"
import {
  placeResource,
  SessionRefSchema,
  ToolDestinationSchema,
  type ToolDestination
} from "./app-destination.js"

const RenameParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema,
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(
    Schema.annotateEncoded({
      description: "New short human-readable Session name."
    })
  )
})

const ArchiveParametersSchema = Schema.Struct({
  session_refs: Schema.Array(SessionRefSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(50))
    .annotate({
      description: "One to 50 exact session_ref values from session_list."
    })
})

const SendMessageParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema,
  message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).pipe(
    Schema.annotateEncoded({
      description: "Self-contained message to deliver to the target Session."
    })
  )
})

const ForwardMessageParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema.annotate({
    description: "Exact session_ref of the chat this capture belongs to, from session_list."
  })
})

const AppOpenParametersSchema = Schema.Struct({
  destination: ToolDestinationSchema,
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)).pipe(
    Schema.annotateEncoded({
      description: "Short imperative label shown to the user, such as 'Open the Ops Space'."
    })
  ),
  mode: Schema.optionalKey(
    Schema.Literals(["offer", "open"] as const).pipe(
      Schema.annotateEncoded({
        description:
          "offer (default): a card in chat the user may open. open: move the user there now; only when they asked to be taken there."
      })
    )
  )
})

interface SessionActionToolServices {
  readonly store: SessionStore["Service"]
  readonly queries: SessionQueries["Service"]
  readonly automations: AutomationCatalog["Service"]
  readonly spaces: SpaceStore["Service"]
  readonly work: WorkStore["Service"]
  readonly wiki: Wiki["Service"]
  readonly events: SessionLifecycleEvents["Service"]
  readonly executions: ToolExecutionStore["Service"]
}

interface SourceRef {
  readonly provider: "arden"
  readonly kind: "session"
  readonly ref: string
  readonly title: string
}

const sessionFailure = (error: SessionStoreError): ToolExecutionError =>
  toolFailure(error, error.reason === "conflict" ? "Session changed" : "Session unavailable")

const sessionQueryFailure = (error: SessionQueryFailure): ToolExecutionError =>
  toolFailure(error, "Session unavailable")

const automationFailure = (error: AutomationStoreError): ToolExecutionError =>
  toolFailure(error, "Automation unavailable")

const spaceFailure = (error: SpaceStoreError): ToolExecutionError =>
  toolFailure(error, "Space unavailable")

const workFailure = (error: WorkStoreError): ToolExecutionError =>
  toolFailure(error, "Work unavailable")

const wikiFailure = (error: WikiError): ToolExecutionError =>
  toolFailure(error, "Memory unavailable")

const eventFailure = (error: SessionLifecycleEventError): ToolExecutionError =>
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

const findSession = async (
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

const resolveSession = async (
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
  if (crossSpace(access, approved) === "allow") return session
  throw unreachableSession(sessionRef, "other_space", access.run.authority.actor)
}

const otherSpaceCard = async (
  services: SessionActionToolServices,
  ctx: ToolContext<ServerRunContext>,
  tool: "session_send_message" | "forward_message",
  sessionRef: string,
  handed: boolean,
  card: (target: { readonly name: string; readonly space: string }) => {
    readonly preview: string
    readonly presentation: Omit<ApprovalPresentation, "fields">
  }
): Promise<ServerApprovalPrompt | undefined> => {
  const access = { run: ctx.run, tool, verb: "message", handed } as const
  const { session, otherSpace } = await reachSession(services, access, sessionRef, ctx.signal)
  if (!otherSpace) return undefined
  const reach = crossSpace(access, false)
  if (reach === "deny") throw unreachableSession(sessionRef, "other_space", ctx.run.authority.actor)
  if (reach === "allow") return undefined
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

const handedOver = (capture: StoredCapture | undefined): boolean =>
  capture !== undefined && capture.forwarded === undefined

type DeliveryRequest = Omit<Parameters<ServerRunContext["sendMessage"]>[0], "sessionId">

const deliverToSession = async (
  services: SessionActionToolServices,
  ctx: ToolContext<ServerRunContext>,
  tool: "session_send_message" | "forward_message",
  sessionRef: string,
  handed: boolean,
  request: (target: SessionListEntry) => DeliveryRequest
): Promise<{ readonly target: SessionListEntry; readonly receipt: ChatReceipt }> => {
  const target = await resolveSession(
    services,
    { run: ctx.run, tool, verb: "message", handed, approval: ctx.approval },
    sessionRef,
    ctx.signal
  )
  if (target.sessionId === ctx.run.sessionId) {
    throw new ToolExecutionError("A message cannot be delivered to the chat it comes from", {
      preview: "Same chat",
      retryable: false
    })
  }
  const receipt = await ctx.run
    .sendMessage({ sessionId: target.sessionId, ...request(target), announce: true })
    .catch((cause: unknown) => {
      throw new ToolExecutionError(errorMessage(cause, "The message could not be delivered"), {
        preview: "Message not delivered",
        retryable: true
      })
    })
  return { target, receipt }
}

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

const resolveDestination = async (
  services: SessionActionToolServices,
  run: ServerRunContext,
  destination: ToolDestination,
  signal: AbortSignal
): Promise<AppDestination> => {
  switch (destination.kind) {
    case "home":
      return { kind: "home" }
    case "session": {
      const session = await resolveSession(
        services,
        { run, tool: "app_open", verb: "open", handed: false },
        destination.session_ref,
        signal
      )
      return { kind: "session", session_id: session.sessionId }
    }
    case "settings":
      return {
        kind: "settings",
        ...(destination.tab === undefined ? {} : { tab: destination.tab })
      }
    case "automation": {
      if (destination.automation_ref === undefined) return { kind: "automation" }
      const automations = await Effect.runPromise(
        services.automations.list().pipe(Effect.mapError(automationFailure)),
        { signal }
      )
      const automation = automations.find(
        (candidate) => candidate.automation_ref === destination.automation_ref
      )
      if (automation === undefined) {
        throw new ToolExecutionError(`No Automation ${destination.automation_ref}`, {
          preview: "Automation not found",
          retryable: false
        })
      }
      return { kind: "automation", task_id: automation.task_id }
    }
    case "task": {
      const page = await Effect.runPromise(
        services.work
          .page({ limit: 1, targetItemId: destination.item_id })
          .pipe(Effect.mapError(workFailure)),
        { signal }
      )
      if (!page.items.some((item) => item.item_id === destination.item_id)) {
        throw new ToolExecutionError(`No active Task ${destination.item_id}`, {
          preview: "Task not found",
          retryable: false
        })
      }
      return { kind: "task", item_id: destination.item_id }
    }
    case "memory": {
      if (destination.path === undefined) return { kind: "memory" }
      const snapshot = await Effect.runPromise(
        services.wiki.snapshot().pipe(Effect.mapError(wikiFailure)),
        { signal }
      )
      const exists = snapshot.pages.some(
        (record) => record.page.lifecycle === "active" && record.resource.path === destination.path
      )
      if (!exists) {
        throw new ToolExecutionError(`No active Memory page at ${destination.path}`, {
          preview: "Memory page not found",
          retryable: false
        })
      }
      return { kind: "memory", path: destination.path }
    }
    case "space": {
      const space = await Effect.runPromise(
        services.spaces.get(destination.space_id).pipe(Effect.mapError(spaceFailure)),
        { signal }
      )
      if (space === null) {
        throw new ToolExecutionError(`No active Space ${destination.space_id}`, {
          preview: "Space not found",
          retryable: false
        })
      }
      return { kind: "space", space_id: space.space_id }
    }
  }
}

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
    description: [
      "Deliver one self-contained message to another active Session by exact session_ref.",
      "It reads there as your handoff from this chat, under a link to this chat; name chats by their titles, never by session_ref.",
      "A running target receives it at the next model-step boundary; an idle target starts a new run. Returns immediately. Asks by default."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(SendMessageParametersSchema),
    metadata: {
      display: { result: "chat_sent" },
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
    description: [
      "Archive active Sessions by exact session_ref.",
      "The current Session is archived once this turn and its agents finish, unless the user writes to it first; another Session with a live run is skipped. Every requested ref is reported."
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
      destructive: true,
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
      const destination = await resolveDestination(services, ctx.run, input.destination, ctx.signal)
      const mode = input.mode ?? "offer"
      const event: NavigationRequestedEvent = {
        type: "navigation_requested",
        origin_session_id: ctx.run.sessionId,
        destination,
        label: input.label,
        mode,
        tool_call_id: ctx.toolCallId
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
