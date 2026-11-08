import type { ChatMessage, ToolCall } from "../contracts/messages.js"
import {
  canRunInBackground,
  mayEndTurn,
  type PendingToolCall,
  type ToolMeta
} from "../contracts/tools.js"
import type { DispatchOutput } from "../tools/dispatch.js"
import { admitToolCalls, loadDeferredCalls } from "./tool-admission.js"
import { hookCall } from "./guards.js"
import type { Run, StepView } from "./run-state.js"

export const isBackgroundCall = (
  call: PendingToolCall,
  meta: ToolMeta | undefined,
  mode: "native" | "message"
): boolean =>
  call.argumentError === undefined &&
  meta?.background === true &&
  canRunInBackground(meta) &&
  (mode === "message" || call.toolCall.async === true)

export interface StreamedToolResults {
  readonly ids: ReadonlySet<string>
  readonly output: DispatchOutput
}

type Settlement =
  | {
      readonly kind: "completed"
      readonly output: DispatchOutput
      readonly messages: ReadonlyArray<ChatMessage>
    }
  | { readonly kind: "failed"; readonly cause: unknown }

export class StreamingTools {
  private readonly ids = new Set<string>()
  private readonly pending: Array<Promise<Settlement>> = []

  constructor(
    private readonly options: {
      readonly run: Run
      readonly view: StepView
      readonly canStart: () => Promise<boolean>
      readonly execute: (call: PendingToolCall, messages: ChatMessage[]) => Promise<DispatchOutput>
    }
  ) {}

  async start(raw: ToolCall, checkpoint: () => Promise<void>): Promise<void> {
    const { run, view } = this.options
    const meta = view.metas.get(raw.function.name)
    if (mayEndTurn(meta) || this.ids.has(raw.id) || !(await this.options.canStart())) return
    const { calls, deferredNames } = admitToolCalls({
      rawCalls: [raw],
      view,
      displayTitle: run.wiring.toolset.displayTitle
    })
    const call = calls[0]
    if (call === undefined) return
    if (!(await run.budget.reserveToolCalls(1, run.wiring.config.maxToolCalls))) return
    await loadDeferredCalls({
      calls,
      deferredNames,
      load: (names) => run.wiring.toolset.load(names)
    })
    await checkpoint()
    this.ids.add(raw.id)
    if (isBackgroundCall(call, meta, view.asyncMode)) {
      const output = await run.background.launch({
        calls: [call],
        metas: view.metas,
        mode: view.asyncMode
      })
      if (output.completions.length > 0 || output.paused.length > 0)
        this.pending.push(Promise.resolve({ kind: "completed", output, messages: [] }))
      return
    }
    const isolated = [...run.messages]
    const offset = isolated.length
    this.pending.push(
      this.options.execute(call, isolated).then(
        (output): Settlement => ({ kind: "completed", output, messages: isolated.slice(offset) }),
        (cause: unknown): Settlement => ({ kind: "failed", cause })
      )
    )
  }

  async settle(): Promise<StreamedToolResults> {
    const completions: Array<DispatchOutput["completions"][number]> = []
    const paused: Array<DispatchOutput["paused"][number]> = []
    for (const pending of this.pending) {
      const settled = await pending
      if (settled.kind === "failed") throw settled.cause
      this.options.run.messages.push(...settled.messages)
      completions.push(...settled.output.completions)
      paused.push(...settled.output.paused)
    }
    if (this.pending.length > 0)
      await this.options.run.history.checkpoint((messages, change) =>
        hookCall("onCheckpoint", () =>
          this.options.run.wiring.hooks.onCheckpoint?.(messages, change)
        )
      )
    return { ids: this.ids, output: { completions, paused } }
  }
}
