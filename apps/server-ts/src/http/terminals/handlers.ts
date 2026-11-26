import { PROCESS_INPUT } from "../../terminals/live-process.js"
import { TERMINAL_PHASE } from "../../terminals/store.js"
import { TERMINAL_STATE, type SessionTerminal } from "@arden-hq/protocol/sessions/terminals"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { TerminalSessions } from "../../terminals/service.js"
import type { TerminalInfo } from "../../terminals/store.js"
import { ArdenApi } from "../api.js"
import { iso } from "../../runtime/clock.js"

export const TerminalHandlers = HttpApiBuilder.group(
  ArdenApi,
  "terminals",
  Effect.fn("TerminalHandlers")(function* (handlers) {
    const store = yield* TerminalSessions
    const owned = (
      sessionId: string,
      terminalId: number
    ): Effect.Effect<TerminalInfo, HttpApiError.NotFound> => {
      const terminal = store.get(terminalId)
      return terminal !== undefined &&
        terminal.sessionId === sessionId &&
        terminal.phase === TERMINAL_PHASE.detached
        ? Effect.succeed(terminal)
        : Effect.fail(new HttpApiError.NotFound({}))
    }

    return handlers
      .handle("list", ({ params }) =>
        Effect.sync(() => ({
          terminals: store
            .list(params.sessionId)
            .filter((terminal) => terminal.phase === TERMINAL_PHASE.detached)
            .map((terminal) => wireTerminal(terminal, store.replay(terminal.id)?.cursor ?? 0))
        }))
      )
      .handle("output", ({ params, query }) =>
        owned(params.sessionId, params.terminalId).pipe(
          Effect.flatMap((terminal) => {
            const replay = store.replay(terminal.id)
            if (replay === undefined) return Effect.fail(new HttpApiError.NotFound({}))
            const available = replay.cursor - replay.output.length
            const start = Math.min(Math.max(query.after, available), replay.cursor)
            return Effect.succeed({
              output: replay.output.slice(start - available),
              start,
              cursor: replay.cursor
            })
          })
        )
      )
      .handle("input", ({ params, payload }) =>
        owned(params.sessionId, params.terminalId).pipe(
          Effect.map((terminal) => ({ status: store.write(terminal.id, payload.chars) }))
        )
      )
      .handle("stop", ({ params }) =>
        owned(params.sessionId, params.terminalId).pipe(
          Effect.map((terminal) => {
            store.kill(terminal.id, { notify: false })
            return { ok: true as const }
          })
        )
      )
      .handle("close", ({ params }) =>
        Effect.sync(() => {
          const terminal = store.get(params.terminalId)
          if (
            terminal?.sessionId === params.sessionId &&
            terminal.phase === TERMINAL_PHASE.detached
          ) {
            store.kill(terminal.id, { notify: false })
            store.remove(terminal.id)
          }
          return { ok: true as const }
        })
      )
  })
)

const wireTerminal = (terminal: TerminalInfo, cursor: number): SessionTerminal => {
  const fields = {
    id: terminal.id,
    tool_call_id: terminal.toolCallId,
    command: terminal.command,
    cwd: terminal.cwd,
    access: terminal.access,
    tty: terminal.input === PROCESS_INPUT.pipe,
    started_at: iso(terminal.startedAt),
    cursor
  }
  return terminal.exit === undefined || terminal.endedAt === undefined
    ? { ...fields, state: TERMINAL_STATE.running }
    : {
        ...fields,
        state: TERMINAL_STATE.exited,
        exit: terminal.exit,
        ended_at: iso(terminal.endedAt)
      }
}
