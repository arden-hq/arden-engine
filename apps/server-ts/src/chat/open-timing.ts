import { performance } from "node:perf_hooks"
import { Effect, Logger } from "effect"
import {
  CHAT_OPEN_SERVER_TIMINGS,
  type ChatOpenServerTiming
} from "@arden-hq/protocol/chat-open-timing"

const traceChatOpen = process.env.ARDEN_CHAT_OPEN_TRACE === "1"
export const chatOpenTracingEnabled = (): boolean => traceChatOpen
export type ChatOpenTimingPhase = ChatOpenServerTiming

export const formatChatOpenServerTiming = (
  timings: Readonly<Partial<Record<ChatOpenTimingPhase, number>>>
): string =>
  CHAT_OPEN_SERVER_TIMINGS.filter((phase) => timings[phase] !== undefined)
    .map((phase) => `arden_chat_open_${phase};dur=${timings[phase]}`)
    .join(", ")
export const logChatOpenTiming = (
  name: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>>
): Effect.Effect<void> =>
  Effect.logInfo(name, fields).pipe(Effect.provideService(Logger.LogToStderr, true))

export interface ChatOpenTimer {
  readonly startedAt: number
  readonly now: () => number
  readonly mark: (phase?: ChatOpenTimingPhase) => number
  readonly total: () => number
  readonly timings: () => Readonly<Partial<Record<ChatOpenTimingPhase, number>>>
}

export const chatOpenTimer = (requestId?: string): ChatOpenTimer | undefined => {
  if (!traceChatOpen && requestId === undefined) return undefined
  const startedAt = performance.now()
  let previousAt = startedAt
  const rounded = (durationMs: number): number =>
    Math.min(120_000, Math.round(durationMs * 100) / 100)
  const phases: Partial<Record<ChatOpenTimingPhase, number>> = {}
  return {
    startedAt,
    now: () => performance.now(),
    mark: (phase) => {
      const current = performance.now()
      const durationMs = current - previousAt
      previousAt = current
      const value = rounded(durationMs)
      if (phase !== undefined) phases[phase] = value
      return value
    },
    total: () => rounded(performance.now() - startedAt),
    timings: () => ({ ...phases, resume_total: rounded(performance.now() - startedAt) })
  }
}
