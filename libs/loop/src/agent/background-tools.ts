import { AgentInvariantError } from "../errors.js"
import { raceAbort } from "../abort.js"
import { launchReceipt, parseToolCalls } from "../tools/dispatch.js"
import type { BackgroundedCall, CallSettlement, DispatchOutput } from "../tools/dispatch.js"
import type { ChatMessage } from "../contracts/messages.js"
import type {
  HeldToolCall,
  PendingToolCall,
  ToolDisplayTitle,
  ToolMeta,
  ToolResult
} from "../contracts/tools.js"
import { normalizeToolResult } from "../internal/validate.js"

type JobState =
  | { readonly kind: "running" }
  | { readonly kind: "settled"; readonly outcome: CallSettlement }
  | { readonly kind: "failed"; readonly cause: unknown }
interface BackgroundJob {
  readonly settled: Promise<void>
  readonly graceUntil: number
  readonly held: HeldToolCall
  state: JobState
}

interface BackgroundLaunch {
  readonly calls: ReadonlyArray<PendingToolCall>
  readonly metas: ReadonlyMap<string, ToolMeta>
  readonly mode: "native" | "message"
  readonly recovered?: ReadonlyMap<string, Required<ToolResult>>
  readonly claimed?: ReadonlyMap<string, HeldToolCall>
}

const capacityRejection: ToolResult = {
  content:
    "Background tool capacity is full. This call was not started. Wait for a pending tool result before retrying.",
  preview: "Background capacity reached",
  is_error: true,
  retryable: true
}

export class BackgroundTools {
  private readonly jobs = new Map<string, BackgroundJob>()
  private replay: { readonly input: BackgroundLaunch; next: number } | undefined

  constructor(
    private readonly options: {
      readonly messages: ChatMessage[]
      readonly signal: AbortSignal
      readonly clock: () => number
      readonly graceMs: number
      readonly capacity: number
      readonly checkpoint: () => Promise<void>
      readonly stop: () => void
      readonly execute: (input: {
        readonly call: PendingToolCall
        readonly messages: ChatMessage[]
        readonly metas: ReadonlyMap<string, ToolMeta>
        readonly recovered?: Required<ToolResult>
        readonly rejection?: ToolResult
      }) => Promise<DispatchOutput>
    }
  ) {}

  get pending(): boolean {
    return this.jobs.size > 0 || this.replay !== undefined
  }

  running(): ReadonlyArray<HeldToolCall> {
    return [...this.jobs.values()].flatMap((job) =>
      job.state.kind === "running" ? [job.held] : []
    )
  }

  async launch(input: BackgroundLaunch): Promise<DispatchOutput> {
    if (input.recovered !== undefined) {
      this.replay = { input, next: 0 }
      await this.fillReplay()
      return { completions: [], paused: [] }
    }
    const available = Math.max(0, this.options.capacity - this.jobs.size)
    const calls = input.calls.filter((call) => !this.jobs.has(call.toolCall.id))
    await this.start({ ...input, calls: calls.slice(0, available) })
    const completions: DispatchOutput["completions"][number][] = []
    const paused: DispatchOutput["paused"][number][] = []
    for (const call of calls.slice(available)) {
      const output = await this.options.execute({
        call,
        messages: this.options.messages,
        metas: input.metas,
        rejection: capacityRejection
      })
      completions.push(...output.completions)
      paused.push(...output.paused)
    }
    if (completions.length > 0) await this.options.checkpoint()
    return { completions, paused }
  }

  private async fillReplay(): Promise<void> {
    while (this.replay !== undefined && this.jobs.size < this.options.capacity) {
      const replay = this.replay
      const end = Math.min(
        replay.input.calls.length,
        replay.next + this.options.capacity - this.jobs.size
      )
      await this.start({ ...replay.input, calls: replay.input.calls.slice(replay.next, end) })
      replay.next = end
      if (end === replay.input.calls.length) this.replay = undefined
    }
  }

  private async start(input: BackgroundLaunch): Promise<void> {
    if (input.calls.length === 0) return
    for (const call of input.calls) {
      if (this.jobs.has(call.toolCall.id)) continue
      const id = call.toolCall.id
      if (this.options.messages.some((message) => message.message_id === `async-launch:${id}`)) {
        if (input.recovered === undefined)
          throw new AgentInvariantError(`Background tool call id was reused: ${id}`)
        continue
      }
      this.options.messages.push(
        input.mode === "native"
          ? {
              role: "user",
              message_id: `async-launch:${id}`,
              is_meta: true,
              async_tool_launch: { call_id: id, delivery: "native" },
              content: []
            }
          : launchReceipt(id)
      )
    }
    await this.options.checkpoint()
    for (const call of input.calls) {
      const id = call.toolCall.id
      if (this.jobs.has(id)) continue
      const isolated = [...this.options.messages]
      const offset = isolated.length
      const claimed = input.claimed?.get(id)
      const recovered =
        claimed === undefined
          ? Promise.resolve(input.recovered?.get(id))
          : claimed.result.then((result) =>
              result === undefined ? undefined : normalizeToolResult(result)
            )
      this.track(
        call,
        backgroundDelivery(this.options.messages, id) ?? input.mode,
        this.options.clock() + this.options.graceMs,
        recovered
          .then((result) =>
            this.options.execute({
              call,
              messages: isolated,
              metas: input.metas,
              ...(result === undefined ? {} : { recovered: result })
            })
          )
          .then((output) => ({ output, messages: isolated.slice(offset) })),
        claimed?.stop ?? this.options.stop
      )
    }
  }

  adopt(backgrounded: BackgroundedCall): void {
    this.track(backgrounded.call, "message", 0, backgrounded.settled, this.options.stop)
  }

  private track(
    call: PendingToolCall,
    delivery: "native" | "message",
    graceUntil: number,
    settled: Promise<CallSettlement>,
    stop: () => void
  ): void {
    const id = call.toolCall.id
    const job: BackgroundJob = {
      graceUntil,
      held: {
        toolCallId: id,
        result: settled.then(
          (outcome) => outcomeResult(outcome, id),
          () => undefined
        ),
        stop
      },
      state: { kind: "running" },
      settled: settled.then(
        (outcome) => {
          job.state = {
            kind: "settled",
            outcome: {
              output: outcome.output,
              messages: outcome.messages.map((message): ChatMessage => {
                if (delivery === "native" || message.role !== "tool") return message
                return {
                  role: "user",
                  message_id: `async-result:${id}`,
                  client_id: `async-result:${id}`,
                  is_meta: true,
                  content: [
                    {
                      type: "context",
                      content_type: "async_tool_result",
                      content: message.content,
                      metadata: { tool_call_id: id, tool_name: call.name }
                    }
                  ]
                }
              })
            }
          }
        },
        (cause: unknown) => {
          job.state = { kind: "failed", cause }
        }
      )
    }
    this.jobs.set(id, job)
  }

  async drain(
    options: {
      readonly grace?: boolean
      readonly wait?: boolean
      readonly maxWaitMs?: number
      readonly wake?: Promise<void>
    } = {}
  ): Promise<DispatchOutput> {
    if (options.grace === true) await this.awaitGrace()
    if (
      options.wait === true &&
      this.jobs.size > 0 &&
      ![...this.jobs.values()].some((job) => job.state.kind !== "running")
    ) {
      const completion = Promise.race([
        ...[...this.jobs.values()].map((job) => job.settled),
        ...(options.wake === undefined ? [] : [options.wake])
      ])
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const maxWaitMs = options.maxWaitMs
        const waiting =
          maxWaitMs === undefined
            ? completion
            : Promise.race([
                completion,
                new Promise<void>((resolve) => {
                  timeout = setTimeout(resolve, Math.max(0, maxWaitMs))
                })
              ])
        await raceAbort(waiting, this.options.signal)
      } finally {
        clearTimeout(timeout)
      }
    }
    let changed = false
    const completions: DispatchOutput["completions"][number][] = []
    const paused: DispatchOutput["paused"][number][] = []
    for (const [id, job] of this.jobs) {
      if (job.state.kind === "failed") throw job.state.cause
      if (job.state.kind === "running") continue
      changed = true
      this.options.messages.push(...job.state.outcome.messages)
      completions.push(...job.state.outcome.output.completions)
      paused.push(...job.state.outcome.output.paused)
      this.jobs.delete(id)
    }
    if (changed) await this.options.checkpoint()
    await this.fillReplay()
    return { completions, paused }
  }

  private async awaitGrace(): Promise<void> {
    const now = this.options.clock()
    const fresh = [...this.jobs.values()].filter(
      (job) => job.state.kind === "running" && job.graceUntil > now
    )
    if (fresh.length === 0) return
    const closesInMs = Math.max(...fresh.map((job) => job.graceUntil)) - now
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await raceAbort(
        Promise.race([
          Promise.all(fresh.map((job) => job.settled)),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, closesInMs)
          })
        ]),
        this.options.signal
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}

const outcomeResult = (outcome: CallSettlement, id: string): ToolResult | undefined => {
  const event = outcome.output.completions.find((completion) => completion.tool_id === id)
  if (event === undefined) return undefined
  return {
    content: event.result,
    preview: event.preview,
    is_error: event.is_error,
    retryable: event.retryable,
    data: event.data,
    message_extras: event.message_extras,
    host: event.host,
    model_content: event.model_content
  }
}

const backgroundDelivery = (
  messages: ReadonlyArray<ChatMessage>,
  id: string
): "native" | "message" | undefined => {
  for (const message of messages) {
    const launch = message.async_tool_launch
    if (
      typeof launch !== "object" ||
      launch === null ||
      !("call_id" in launch) ||
      launch.call_id !== id ||
      !("delivery" in launch)
    )
      continue
    if (launch.delivery === "native" || launch.delivery === "message") return launch.delivery
  }
  return undefined
}

/** Receipts close portable wire calls but do not settle the underlying execution. */
export const pendingBackgroundCalls = (
  messages: ReadonlyArray<ChatMessage>,
  options: { readonly displayTitle?: ToolDisplayTitle | undefined } = {}
): ReadonlyArray<PendingToolCall> => {
  const outputs = new Set(
    messages.flatMap((message) =>
      message.role === "tool" && message.async_tool_launch === undefined
        ? [message.tool_call_id]
        : []
    )
  )
  const delivered = new Set(
    messages.flatMap((message) =>
      typeof message.client_id === "string" ? [message.client_id] : []
    )
  )
  return parseToolCalls(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.tool_calls ?? []).filter((call) => {
            const delivery = backgroundDelivery(messages, call.id)
            return (
              delivery !== undefined &&
              (delivery === "native"
                ? !outputs.has(call.id)
                : !delivered.has(`async-result:${call.id}`))
            )
          })
        : []
    ),
    options.displayTitle
  )
}
