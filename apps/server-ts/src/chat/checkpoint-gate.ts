import type { ChatRunnerContextReport, ChatRunnerMessage } from "./runner-contract.js"

export interface CheckpointRequest {
  readonly messages: ReadonlyArray<ChatRunnerMessage>
  readonly revision?: number
  readonly context: ChatRunnerContextReport | undefined
  readonly completionMessageId: string | undefined
  readonly eventSequence: number | undefined
}

type CheckpointWrite = () => Promise<number | undefined>

interface StoredCheckpoint {
  readonly request: CheckpointRequest
  readonly done: Promise<void>
}

export const makeCheckpointGate = (): ((
  request: CheckpointRequest,
  write: CheckpointWrite
) => Promise<void>) => {
  let stored: StoredCheckpoint | undefined
  return (request, write) => {
    if (stored !== undefined && sameCheckpoint(stored.request, request)) return stored.done
    const done = write().then(
      (covered) => {
        if (stored?.request === request)
          stored = { request: { ...request, eventSequence: covered }, done }
      },
      (error: unknown) => {
        if (stored?.request === request) stored = undefined
        throw error
      }
    )
    stored = { request, done }
    return done
  }
}

const sameCheckpoint = (left: CheckpointRequest, right: CheckpointRequest): boolean =>
  left.eventSequence === right.eventSequence &&
  left.completionMessageId === right.completionMessageId &&
  sameContext(left.context, right.context) &&
  (left.revision !== undefined && right.revision !== undefined
    ? left.revision === right.revision
    : left.messages.length === right.messages.length &&
      left.messages.every((message, index) => message === right.messages[index]))

const sameContext = (
  left: ChatRunnerContextReport | undefined,
  right: ChatRunnerContextReport | undefined
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.inputTokens === right.inputTokens &&
    left.usage.prompt === right.usage.prompt &&
    left.usage.completion === right.usage.completion &&
    left.usage.cache_read === right.usage.cache_read &&
    left.usage.cache_write === right.usage.cache_write)
