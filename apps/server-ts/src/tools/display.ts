import type { ToolDisplay } from "@arden-hq/protocol/tools"

const RETIRED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  bash: "exec_command"
}

const UNLISTED_TOOL_DISPLAY: Readonly<Record<string, ToolDisplay>> = {
  no_reply: { trail: "hidden" },
  automation_blocked: { row: "blocked" },
  load_tools: { result: "tool_list" },
  tool_search: { result: "tool_list" }
}

export const unlistedToolDisplay = (
  displayOf: (name: string) => ToolDisplay | undefined
): Readonly<Record<string, ToolDisplay>> => ({
  ...UNLISTED_TOOL_DISPLAY,
  ...Object.fromEntries(
    Object.entries(RETIRED_TOOL_ALIASES).map(([retired, current]) => [
      retired,
      displayOf(current) ?? {}
    ])
  )
})
