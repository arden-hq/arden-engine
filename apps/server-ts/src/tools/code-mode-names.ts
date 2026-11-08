/**
 * The model sees provider-namespaced names (`functions.x`, `space.x`,
 * `browser_tools.x`) and copies the habit into scripts; a script's flat tool
 * list has bare names only.
 */

export interface CodeModeToolFacts {
  readonly name: string
  readonly codeMode: boolean
  readonly hosted: boolean
  readonly endsTurn: boolean
  readonly agentTool: boolean
  readonly inScope: boolean
}

export const resolveToolName = (
  requested: string,
  known: ReadonlySet<string>
): string | undefined => {
  const name = requested.trim()
  if (known.has(name)) return name
  if (name.startsWith("mcp__")) return undefined
  for (let index = 0; index < name.length; index += 1) {
    let separator = 0
    if (name.startsWith("__", index)) separator = 2
    else if (name[index] === ".") separator = 1
    if (separator === 0) continue
    const rest = name.slice(index + separator)
    if (known.has(rest)) return rest
    if (rest.startsWith("mcp__")) return undefined
  }
  return undefined
}

export const refusalReason = (tool: CodeModeToolFacts): string | undefined => {
  if (!tool.inScope) return `${tool.name} is not available in this chat`
  if (!tool.codeMode) {
    return tool.agentTool
      ? `${tool.name} cannot be called from a script. Use agent() inside the script to start a child agent.`
      : `${tool.name} cannot be called from a script. Call it directly, outside code_mode.`
  }
  if (tool.hosted) {
    return `${tool.name} cannot be called from a script. It is a hosted tool; call it directly, outside code_mode.`
  }
  if (tool.endsTurn) {
    return `${tool.name} ends the turn, so a script cannot call it. Call it directly, by itself.`
  }
  return undefined
}

const comparable = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "")

const MAX_SUGGESTIONS = 5
const LIST_ALL_LIMIT = 20

export const unknownToolMessage = (requested: string, callable: ReadonlyArray<string>): string => {
  const needle = comparable(requested.split(".").at(-1) ?? requested)
  const close =
    needle.length === 0
      ? []
      : callable
          .filter((name) => {
            const candidate = comparable(name)
            return (
              candidate.length > 0 && (candidate.includes(needle) || needle.includes(candidate))
            )
          })
          .slice(0, MAX_SUGGESTIONS)
  if (close.length > 0) return `Unknown tool ${requested}. Did you mean ${close.join(", ")}?`
  if (callable.length > 0 && callable.length <= LIST_ALL_LIMIT) {
    return `Unknown tool ${requested}. Available: ${callable.join(", ")}.`
  }
  return `Unknown tool ${requested}.`
}
