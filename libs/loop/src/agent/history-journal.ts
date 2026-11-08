import type { ChatMessage } from "../contracts/messages.js"
import { decodeMessage } from "../internal/validate.js"

/** Changes to the canonical history since the last successful checkpoint hook. */
export type HistoryChange =
  | {
      readonly kind: "append"
      readonly revision: number
      readonly start: number
      readonly messages: ReadonlyArray<ChatMessage>
    }
  | {
      readonly kind: "replace"
      readonly revision: number
      readonly messages: ReadonlyArray<ChatMessage>
    }

export interface HistoryJournal {
  readonly messages: ChatMessage[]
  readonly checkpoint: (
    write: (messages: ReadonlyArray<ChatMessage>, change: HistoryChange) => Promise<void>
  ) => Promise<void>
}

const freezeMessage = (message: ChatMessage): ChatMessage => {
  const seen = new WeakSet<object>()
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(message)
  return message
}

export const makeHistoryJournal = (initial: ReadonlyArray<ChatMessage>): HistoryJournal => {
  const target = initial.map((message) => freezeMessage(structuredClone(message)))
  let revision = 0
  let replacement = 0
  let acknowledgedReplacement = -1
  let acknowledgedLength = 0
  let pending: Promise<void> = Promise.resolve()
  let queued = 0

  const messages = new Proxy(target, {
    set(array, property, value, receiver) {
      const oldLength = array.length
      const index =
        typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)
          ? Number(property)
          : undefined
      const changed = Reflect.set(
        array,
        property,
        index === undefined ? value : freezeMessage(structuredClone(decodeMessage(value))),
        receiver
      )
      if (!changed) return false
      if (index !== undefined) {
        revision += 1
        if (index < oldLength) replacement += 1
      } else if (property === "length" && value < oldLength) {
        revision += 1
        replacement += 1
      }
      return true
    },
    deleteProperty(array, property) {
      const changed = Reflect.deleteProperty(array, property)
      if (changed) {
        revision += 1
        replacement += 1
      }
      return changed
    }
  })

  return {
    messages,
    checkpoint(write) {
      const askedRevision = revision
      const askedReplacement = replacement
      const askedLength = messages.length
      const run = async () => {
        const changedWhileQueued = revision !== askedRevision
        const capturedRevision = changedWhileQueued ? revision : askedRevision
        const capturedReplacement = changedWhileQueued ? replacement : askedReplacement
        const capturedLength = changedWhileQueued ? messages.length : askedLength
        const change: HistoryChange =
          !changedWhileQueued && capturedReplacement === acknowledgedReplacement
            ? {
                kind: "append",
                revision: capturedRevision,
                start: acknowledgedLength,
                messages: messages.slice(acknowledgedLength, capturedLength)
              }
            : { kind: "replace", revision: capturedRevision, messages: messages.slice() }
        await write(target, change)
        acknowledgedReplacement = capturedReplacement
        acknowledgedLength = capturedLength
      }
      const next = queued === 0 ? run() : pending.then(run)
      queued += 1
      void next.then(
        () => {
          queued -= 1
        },
        () => {
          queued -= 1
        }
      )
      pending = next.catch(() => undefined)
      return next
    }
  }
}
