/**
 * The tool-call ordering every function-calling wire requires: each runtime
 * call is answered by its output before the conversation goes on. Stored
 * history does not always hold that order (background results, steering and
 * current context arrive while calls are pending; a crash leaves a call
 * unanswered), so each adapter converts its messages into wire items in
 * batches and this one algorithm orders them.
 */

/** Wire items converted from one stored message, in order. */
export interface ToolHistoryBatch<Item> {
  readonly items: ReadonlyArray<Item>
  /**
   * Context and steering: held back while calls are pending and sent right
   * after their outputs. Any other batch closes pending calls first.
   */
  readonly deferWhileCallsPending: boolean
}

/** How one wire names calls and outputs; ids are raw and checked here. */
export interface ToolHistoryWire<Item> {
  /** Names the history in failures: "Stored <name> contains duplicate function call <id>". */
  readonly name: string
  /** The runtime calls an item opens; `async` calls may be answered after the response ends. */
  readonly calls: (item: Item) => ReadonlyArray<{ readonly id: unknown; readonly async: boolean }>
  /** The raw id of the call an item answers, or undefined for an item that answers none. */
  readonly answers: (item: Item) => { readonly id: unknown } | undefined
  /** The output sent for a call whose output was never recorded. */
  readonly missingOutput: (callId: string) => Item
  /** The adapter's failure for malformed stored history. */
  readonly fail: (message: string) => Error
}

/** The output text for a call the stored history never answered. */
export const MISSING_TOOL_OUTPUT =
  "Tool output was not recorded. The call may have been interrupted; check its effects before retrying."

/**
 * Orders the batches so every call is followed by its output: deferred
 * batches wait for pending outputs, an output recorded later than an
 * interruption moves up to it, and a call never answered gets
 * `missingOutput`. Duplicate calls and outputs without a call are failures.
 */
export function orderToolHistory<Item>(
  batches: ReadonlyArray<ToolHistoryBatch<Item>>,
  wire: ToolHistoryWire<Item>
): ReadonlyArray<Item> {
  const callId = (raw: unknown): string => {
    if (typeof raw === "string" && raw.length > 0) return raw
    throw wire.fail(`Stored ${wire.name} contains an invalid function call id`)
  }
  const duplicate = (id: string): Error =>
    wire.fail(`Stored ${wire.name} contains duplicate function call ${id}`)
  const orphan = (id: string): Error =>
    wire.fail(`Stored ${wire.name} contains output without matching function call ${id}`)

  // The recorded output of each call occurrence, keyed by the item that opened it.
  const outputs = new Map<Item, Map<string, Item>>()
  const outstanding = new Map<string, Item>()
  for (const batch of batches) {
    for (const item of batch.items) {
      for (const call of wire.calls(item)) {
        const id = callId(call.id)
        if (outstanding.has(id)) throw duplicate(id)
        outstanding.set(id, item)
      }
      const answer = wire.answers(item)
      if (answer === undefined) continue
      const id = callId(answer.id)
      const opener = outstanding.get(id)
      if (opener === undefined) throw orphan(id)
      const recorded = outputs.get(opener) ?? new Map<string, Item>()
      recorded.set(id, item)
      outputs.set(opener, recorded)
      outstanding.delete(id)
    }
  }

  const openers = new Map<string, Item>()
  const consumedOutputs = new Set<Item>()
  const pending = new Set<string>()
  const asynchronous = new Set<string>()
  const deferredToolContext: Array<Item> = []
  const input: Array<Item> = []
  const closeInterruptedCalls = () => {
    for (const id of pending) {
      const opener = openers.get(id)
      const recorded = opener === undefined ? undefined : outputs.get(opener)?.get(id)
      if (recorded !== undefined) consumedOutputs.add(recorded)
      input.push(recorded ?? wire.missingOutput(id))
    }
    pending.clear()
    input.push(...deferredToolContext.splice(0))
  }

  for (const batch of batches) {
    if (pending.size > 0 && batch.deferWhileCallsPending) {
      deferredToolContext.push(...batch.items)
      continue
    }
    if (pending.size > 0 && batch.items.some((item) => wire.answers(item) === undefined)) {
      closeInterruptedCalls()
    }
    for (const item of batch.items) {
      if (consumedOutputs.has(item)) continue
      for (const call of wire.calls(item)) {
        const id = callId(call.id)
        openers.set(id, item)
        if (pending.has(id) || asynchronous.has(id)) throw duplicate(id)
        if (call.async) asynchronous.add(id)
        else pending.add(id)
      }
      const answer = wire.answers(item)
      if (answer === undefined) continue
      const id = callId(answer.id)
      if (!pending.has(id) && !asynchronous.has(id)) throw orphan(id)
      pending.delete(id)
      asynchronous.delete(id)
    }
    input.push(...batch.items.filter((item) => !consumedOutputs.has(item)))
    if (pending.size === 0 && deferredToolContext.length > 0) {
      input.push(...deferredToolContext.splice(0))
    }
  }

  closeInterruptedCalls()
  return input
}
