import type { ModelContentBlock, ToolCallRequest, ToolResult } from "@arden-hq/loop"
import type { ToolsetMiddleware } from "../execution/toolset-middleware.js"

export const SKILL_TOOL_NAME = "skill"
export const TRUSTED_SKILL_CONTENT_TYPE = "trusted_skill_instructions"
export const BUILT_IN_SKILL_SOURCE = "arden_builtin_skill"
export const LOCAL_SKILL_SOURCE = "user_installed_local_skill"

const SKILL_SOURCES: ReadonlySet<unknown> = new Set([BUILT_IN_SKILL_SOURCE, LOCAL_SKILL_SOURCE])

const carriedSkill = (block: ModelContentBlock): string | undefined => {
  if (block.type !== "context" || block.content_type !== TRUSTED_SKILL_CONTENT_TYPE)
    return undefined
  const name = block.metadata?.skill_name
  return SKILL_SOURCES.has(block.metadata?.source) &&
    typeof name === "string" &&
    typeof block.metadata?.source_sha256 === "string"
    ? name
    : undefined
}

const keepBlock = (block: ModelContentBlock, toolName: string): boolean => {
  if (block.type !== "context" || block.content_type !== TRUSTED_SKILL_CONTENT_TYPE) return true
  return toolName === SKILL_TOOL_NAME && carriedSkill(block) !== undefined
}

export const skillGuard = (options: { readonly omit?: ReadonlySet<string> }): ToolsetMiddleware => {
  const settle = (request: ToolCallRequest, result: ToolResult): ToolResult => {
    if (result.model_content === undefined) return result
    const kept = result.model_content.filter((block) => keepBlock(block, request.name))
    if (request.name === SKILL_TOOL_NAME) {
      const omitted = kept
        .map(carriedSkill)
        .find((name) => name !== undefined && options.omit?.has(name) === true)
      if (omitted !== undefined) {
        return {
          content: `The ${omitted} Skill is not available in this run. The coordination rules for this run are already in your base and run instructions; follow them and continue.`,
          preview: "Skill unavailable",
          is_error: true,
          retryable: false
        }
      }
    }
    return kept.length === result.model_content.length ? result : { ...result, model_content: kept }
  }
  return {
    execute: async (request, next) => settle(request, await next(request)),
    decorateResult: settle
  }
}
