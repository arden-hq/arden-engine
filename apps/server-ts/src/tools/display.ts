import type { ToolDisplay } from "@arden-hq/protocol/tools"

import type { ServerTool } from "./define.js"

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

export const toolTitle = (tool: ServerTool, server: string | null): string => {
  const name = tool.meta.display_name
  const suffix = server === null ? "" : ` (${server})`
  return suffix !== "" && name.endsWith(suffix)
    ? name.slice(0, -suffix.length).replace(/[_-]+/gu, " ").trim()
    : name
}
