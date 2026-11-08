import type { ProviderToolCall, ToolCall } from "../contracts/messages.js"
import type { PendingToolCall, ToolDisplayTitle, Toolset } from "../contracts/tools.js"
import { gateUnavailableCalls, parseToolCalls } from "../tools/dispatch.js"
import type { StepView } from "./run-state.js"

export const admitToolCalls = ({
  rawCalls,
  view,
  displayTitle
}: {
  readonly rawCalls: ReadonlyArray<ToolCall>
  readonly view: Pick<StepView, "tools" | "deferredTools">
  readonly displayTitle: ToolDisplayTitle | undefined
}): {
  readonly calls: ReadonlyArray<PendingToolCall>
  readonly deferredNames: ReadonlySet<string>
} => {
  const visible = view.tools.map((tool) => tool.name).sort()
  const deferredNames = new Set(view.deferredTools.map((tool) => tool.name))
  return {
    calls: gateUnavailableCalls(
      parseToolCalls(rawCalls, displayTitle),
      new Set([...visible, ...deferredNames]),
      visible
    ),
    deferredNames
  }
}

export const loadDeferredCalls = async ({
  calls,
  deferredNames,
  load,
  providerCalls = []
}: {
  readonly calls: ReadonlyArray<PendingToolCall>
  readonly deferredNames: ReadonlySet<string>
  readonly load: Toolset["load"]
  readonly providerCalls?: ReadonlyArray<ProviderToolCall>
}): Promise<ReadonlySet<string>> => {
  const loaded = new Set(
    calls.filter((call) => deferredNames.has(call.name)).map((call) => call.name)
  )
  for (const call of providerCalls) {
    for (const name of call.loaded_tool_names ?? []) {
      if (deferredNames.has(name)) loaded.add(name)
    }
  }
  if (loaded.size > 0) await load(loaded)
  return loaded
}
