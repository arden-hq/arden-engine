import type { ChatRunningWork } from "@arden-hq/protocol/sessions"
import { chatName } from "@arden-hq/protocol/views"
import { Context, Effect, Layer } from "effect"
import { RunQueries, type ChatWork, type RunQueryError } from "../persistence/runs/queries.js"
import type { ScriptStoreError } from "../persistence/scripts/store.js"
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { SessionStore, type SessionStoreError } from "../persistence/sessions/store.js"
import type { MutationOperationIdentity } from "../persistence/tools/mutation-receipt.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import { SpaceStore, type SpaceStoreError } from "../persistence/spaces/store.js"
import { TerminalSessions } from "../terminals/service.js"
import { ScriptRunner } from "../workflows/script-runner.js"
import { ChatMessageError, type ChatMessageFailure } from "./message-errors.js"
import { ChatMessage } from "./message.js"

export type ChatEnd = "archive" | "delete"

export type ChatEndResult =
  | { readonly kind: "ended" }
  | { readonly kind: "not_found" }
  | { readonly kind: "running"; readonly running: ChatRunningWork }

export type SpaceEndResult =
  | { readonly kind: "ended" }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "running"
      readonly chats: ReadonlyArray<{ readonly name: string; readonly running: ChatRunningWork }>
    }

type ChatStopFailure = RunQueryError | ScriptStoreError | WorkStoreError | ChatMessageFailure

export class ChatStop extends Context.Service<
  ChatStop,
  {
    readonly running: (sessionId: string) => Effect.Effect<ChatRunningWork, RunQueryError>
    readonly stop: (sessionId: string) => Effect.Effect<void, ChatStopFailure>
    readonly end: (input: {
      readonly sessionId: string
      readonly action: ChatEnd
      readonly stop: boolean
      readonly mutation?: MutationOperationIdentity
    }) => Effect.Effect<ChatEndResult, ChatStopFailure | SessionStoreError>
    readonly archivePending: () => Effect.Effect<void, SessionStoreError>
    readonly endSpace: (input: {
      readonly spaceId: string
      readonly stop: boolean
    }) => Effect.Effect<SpaceEndResult, ChatStopFailure | SessionQueryFailure | SpaceStoreError>
  }
>()("@arden-hq/server/chat/ChatStop") {
  static readonly layer = Layer.effect(
    ChatStop,
    Effect.gen(function* () {
      const chat = yield* ChatMessage
      const runs = yield* RunQueries
      const terminals = yield* TerminalSessions
      const scripts = yield* ScriptRunner
      const sessions = yield* SessionStore
      const sessionQueries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const deliveries = yield* WorkStore

      const liveCommands = (work: ChatWork) =>
        work.sessionIds.flatMap((sessionId) =>
          terminals.list(sessionId).filter((terminal) => terminal.exit === undefined)
        )

      const running = Effect.fn("ChatStop.running")(function* (sessionId: string) {
        const work = yield* runs.chatWork(sessionId)
        return countRunningWork(work, liveCommands(work).length)
      })

      const stop = Effect.fn("ChatStop.stop")(function* (sessionId: string) {
        const work = yield* runs.chatWork(sessionId)
        const runIds = work.runs.map((run) => run.runId)
        yield* chat.stopRuns([
          ...new Set([...runIds, ...liveCommands(work).map((terminal) => terminal.runId)])
        ])
        for (const chatSessionId of work.sessionIds)
          yield* chat
            .cancel({ sessionId: chatSessionId })
            .pipe(
              Effect.catch((error) =>
                error instanceof ChatMessageError && error.reason === "not_found"
                  ? Effect.void
                  : Effect.fail(error)
              )
            )
        yield* scripts.cancelFenced({
          cancelAgent: (input) => Effect.runPromise(chat.stopRuns([input.runId]))
        })
        yield* deliveries.discardStoppedResults(runIds)
      })

      const act = (
        sessionId: string,
        action: ChatEnd,
        mutation: MutationOperationIdentity | undefined
      ) =>
        (action === "archive"
          ? sessions.archive(sessionId, mutation)
          : sessions.permanentDelete(sessionId)
        ).pipe(Effect.map((found): ChatEndResult => ({ kind: found ? "ended" : "not_found" })))

      const end = Effect.fn("ChatStop.end")(function* (input: {
        readonly sessionId: string
        readonly action: ChatEnd
        readonly stop: boolean
        readonly mutation?: MutationOperationIdentity
      }) {
        if (!input.stop) {
          const now = yield* running(input.sessionId)
          if (hasRunningWork(now)) return { kind: "running", running: now } satisfies ChatEndResult
          return yield* act(input.sessionId, input.action, input.mutation)
        }
        for (let attempt = 1; ; attempt += 1) {
          yield* stop(input.sessionId)
          const ended = yield* act(input.sessionId, input.action, input.mutation).pipe(
            Effect.result
          )
          if (ended._tag === "Success") return ended.success
          const again = yield* running(input.sessionId)
          if (attempt >= STOP_ATTEMPTS || !hasRunningWork(again)) return yield* ended.failure
        }
      })

      const busyChats = Effect.fn("ChatStop.busyChats")(function* (spaceId: string) {
        const chats = yield* sessionQueries.openSpaceChats(spaceId)
        const busy: Array<{ readonly name: string; readonly running: ChatRunningWork }> = []
        for (const chat of chats) {
          const now = yield* running(chat.sessionId)
          if (hasRunningWork(now)) busy.push({ name: chatName(chat), running: now })
        }
        return { chats, busy }
      })

      const endSpace = Effect.fn("ChatStop.endSpace")(function* (input: {
        readonly spaceId: string
        readonly stop: boolean
      }) {
        const first = yield* busyChats(input.spaceId)
        if (!input.stop && first.busy.length > 0)
          return { kind: "running", chats: first.busy } satisfies SpaceEndResult
        for (let attempt = 1; ; attempt += 1) {
          if (input.stop) for (const chat of first.chats) yield* stop(chat.sessionId)
          const archived = yield* spaces.archive(input.spaceId).pipe(Effect.result)
          if (archived._tag === "Success")
            return {
              kind: archived.success === null ? "not_found" : "ended"
            } satisfies SpaceEndResult
          const again = yield* busyChats(input.spaceId)
          if (attempt >= STOP_ATTEMPTS || again.busy.length === 0) return yield* archived.failure
          if (!input.stop) return { kind: "running", chats: again.busy } satisfies SpaceEndResult
        }
      })

      const archivePending = Effect.fn("ChatStop.archivePending")(function* () {
        for (const pending of yield* sessions.pendingArchives()) {
          yield* end({
            sessionId: pending.sessionId,
            action: "archive",
            stop: false,
            mutation: pending.mutation
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not archive the chat that asked for it", {
                sessionId: pending.sessionId,
                cause
              })
            )
          )
        }
      })

      return ChatStop.of({ running, stop, end, endSpace, archivePending })
    })
  )
}

const STOP_ATTEMPTS = 3

const countRunningWork = (work: ChatWork, commands: number): ChatRunningWork => ({
  replies: work.runs.filter((run) => run.kind === "reply").length,
  agents: work.runs.filter((run) => run.kind === "agent").length,
  automations: work.runs.filter((run) => run.kind === "automation").length,
  workflows: work.workflows.length,
  commands
})

const hasRunningWork = (work: ChatRunningWork): boolean =>
  work.replies + work.agents + work.automations + work.workflows + work.commands > 0
