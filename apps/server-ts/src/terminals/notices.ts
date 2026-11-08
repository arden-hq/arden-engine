import { formatDurationFine } from "@arden-hq/std/time"
import { Effect, FiberSet, Layer } from "effect"

import { ChatMessage } from "../chat/message.js"
import { DataRoot } from "../runtime/data-root.js"
import type { ProcessExit } from "./live-process.js"
import {
  terminalsFile,
  writeRunning,
  enqueueTerminalNotice,
  acknowledgeTerminalNotice,
  pendingTerminalNotices,
  noticeInput,
  type TerminalNotice
} from "./restart-notices.js"
import { TerminalSessions } from "./service.js"
import type { ExitNotice, TerminalInfo } from "./store.js"

const EXIT_NOTICE_DELAY_MS = 1_500

export const TerminalNoticesRuntime: Layer.Layer<
  never,
  never,
  TerminalSessions | ChatMessage | DataRoot
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* TerminalSessions
    const chat = yield* ChatMessage
    const root = yield* DataRoot
    const file = terminalsFile(root.dir)
    const runFork = yield* FiberSet.makeRuntime<never, void, never>()
    const send = (notice: TerminalNotice) =>
      chat.send(noticeInput(notice)).pipe(
        Effect.tap(() =>
          Effect.sync(() => acknowledgeTerminalNotice(file, notice.sessionId, notice.clientId))
        ),
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not tell Arden about a command", { cause })
        )
      )

    const persist = (): void => writeRunning(file, store.all().filter(isRunningDetached))
    persist()

    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    yield* Effect.forkScoped(
      Effect.sleep("1 minute").pipe(
        Effect.andThen(
          Effect.suspend(() =>
            Effect.forEach(
              pendingTerminalNotices(file).filter(
                (notice) => !timers.has(JSON.stringify([notice.sessionId, notice.clientId]))
              ),
              send,
              { discard: true }
            )
          )
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not retry terminal notices", { cause })
        ),
        Effect.forever
      )
    )
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "output") return
      if (event.type === "state") {
        const notice = store.peekExitNotice(event.terminal.id)
        if (notice !== undefined) enqueueTerminalNotice(file, exitNotice(notice))
      }
      persist()
      if (event.type !== "state" || event.terminal.exit === undefined) return
      if (event.terminal.phase !== "detached") return
      const id = event.terminal.id
      const key = JSON.stringify([
        event.terminal.sessionId,
        `terminal-exit:${event.terminal.toolCallId}`
      ])
      if (timers.has(key)) return
      const timer = setTimeout(() => {
        timers.delete(key)
        const notice = store.takeExitNotice(id)
        if (notice !== undefined) runFork(send(exitNotice(notice)))
        else
          acknowledgeTerminalNotice(
            file,
            event.terminal.sessionId,
            `terminal-exit:${event.terminal.toolCallId}`
          )
      }, EXIT_NOTICE_DELAY_MS)
      timers.set(key, timer)
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribe()
        for (const timer of timers.values()) clearTimeout(timer)
      })
    )
  })
)

const isRunningDetached = (terminal: TerminalInfo): boolean =>
  terminal.phase === "detached" && terminal.exit === undefined

const exitNotice = ({ terminal, tail }: ExitNotice): TerminalNotice => {
  const exit = terminal.exit
  const elapsed = (terminal.endedAt ?? terminal.startedAt) - terminal.startedAt
  const content = [
    `The command you left running ${exitPhrase(exit)} after ${formatDurationFine(elapsed)}: \`${terminal.command}\` (session ${terminal.id}).`,
    tail.trim().length === 0 ? "It printed nothing new." : `Last output:\n${tail}`
  ].join("\n")
  return {
    sessionId: terminal.sessionId,
    toolCallId: terminal.toolCallId,
    id: terminal.id,
    command: terminal.command,
    approvalMode: terminal.approvalMode,
    clientId: `terminal-exit:${terminal.toolCallId}`,
    content,
    outcome: exit?.kind === "code" && exit.code === 0 ? "completed" : "failed"
  }
}

const exitPhrase = (exit: ProcessExit | undefined): string => {
  if (exit === undefined) return "ended"
  return exit.kind === "code" ? `exited with code ${exit.code}` : `was stopped (${exit.signal})`
}
