import type { ToolCall, ToolStarted } from "@arden-hq/loop"
import type { ToolRun } from "./durable-tools.js"
import type { RunPurposeInput } from "./run-purpose.js"
import type { ChatRunnerMessage } from "./runner-contract.js"

export interface RunPurposeObserver {
  readonly begin: () => void
  readonly checkpoint: (messages: ReadonlyArray<ChatRunnerMessage>) => void
  readonly steer: (messages: ReadonlyArray<ChatRunnerMessage>) => void
  readonly work: (event: ToolStarted) => void
  readonly stop: () => void
}

export const makeRunPurposeObserver = ({
  run,
  turnId,
  messages,
  launch
}: {
  readonly run: ToolRun
  readonly turnId: string
  readonly messages: ReadonlyArray<ChatRunnerMessage>
  readonly launch: (request: RunPurposeInput, settled: () => void) => void
}): RunPurposeObserver => {
  let latest = messages
  let revision = 0
  let began = false
  let pending: { readonly batch: ReadonlyArray<ToolCall>; readonly revision: number } | undefined
  let active: AbortController | undefined
  let stopped = false
  const seen = new Set<string>()

  const start = (): void => {
    if (stopped || active !== undefined || pending === undefined) return
    const snapshot = pending
    pending = undefined
    const controller = new AbortController()
    active = controller
    launch(
      {
        run: { ...run, signal: AbortSignal.any([run.signal, controller.signal]) },
        turnId,
        batch: snapshot.batch,
        unchanged: () => !stopped && snapshot.revision === revision
      },
      () => {
        if (active !== controller) return
        active = undefined
        start()
      }
    )
  }

  const stop = (): void => {
    stopped = true
    pending = undefined
    active?.abort()
    run.signal.removeEventListener("abort", stop)
  }
  if (run.signal.aborted) stop()
  else run.signal.addEventListener("abort", stop, { once: true })

  const describeTask = (): void => {
    began = true
    pending = { batch: [], revision }
    start()
  }

  return {
    begin: () => {
      if (!began && !stopped) describeTask()
    },
    checkpoint: (history) => {
      latest = history
    },
    steer: (accepted) => {
      if (stopped) return
      revision += 1
      latest = [...latest, ...accepted]
      active?.abort()
      describeTask()
    },
    work: (event) => {
      if (stopped || seen.has(event.tool_id)) return
      const assistant = latest.findLast(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.some((call) => call.id === event.tool_id)
      )
      const batch = (assistant?.role === "assistant" ? assistant.tool_calls : undefined) ?? [
        {
          id: event.tool_id,
          type: "function",
          function: { name: event.name, arguments: JSON.stringify(event.args) }
        }
      ]
      for (const call of batch) seen.add(call.id)
      pending = { batch, revision }
      start()
    },
    stop
  }
}
