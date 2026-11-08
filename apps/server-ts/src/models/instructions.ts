import { PROMPT_TEXT, renderChatBasePrompt } from "../prompts/catalog.js"
import { joinPromptSections, renderPromptSection } from "../prompts/format.js"

const UNTRUSTED_DATA_RULE = PROMPT_TEXT.untrustedDataRule

export const withUntrustedDataRule = (instructions: string): string => {
  if (instructions.includes(UNTRUSTED_DATA_RULE)) return instructions
  if (instructions.includes("## Trust boundary")) {
    return `${instructions.trimEnd()}\n${UNTRUSTED_DATA_RULE}`
  }
  const prompt = joinPromptSections([
    instructions,
    renderPromptSection("Trust boundary", UNTRUSTED_DATA_RULE)
  ])
  if (prompt === undefined) throw new Error("Model instructions must not be empty")
  return prompt
}

export const baseSystemPrompt = (assistantName: string): string =>
  withUntrustedDataRule(renderChatBasePrompt(assistantName).text)
