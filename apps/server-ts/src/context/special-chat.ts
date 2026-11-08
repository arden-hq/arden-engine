import { Option, Schema } from "effect"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { cutText } from "@arden-hq/std/text"
import { renderPromptSection } from "../prompts/format.js"

export interface SpecialChat {
  readonly kind: "capture" | "onboarding"
  readonly context: string
}

const MarkSchema = Schema.Struct({ at: Schema.String })
const marked = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(MarkSchema)(value))

export const readSpecialChat = (
  metadata: Readonly<Record<string, unknown>>
): SpecialChat | undefined => {
  if (marked(metadata["capture"]))
    return { kind: "capture", context: renderPromptSection("Handed capture", PROMPT_TEXT.capture) }
  if (marked(metadata["onboarding"]))
    return {
      kind: "onboarding",
      context: renderPromptSection("Getting started", PROMPT_TEXT.onboarding)
    }
  return undefined
}

const CAPTURE_SPACE_TEXT_MAX = 300

export const renderCaptureSpaces = (
  spaces: ReadonlyArray<{
    readonly space_id: string
    readonly name: string
    readonly instructions: string | null
  }>
): string =>
  renderPromptSection(
    "Spaces to file it under",
    spaces
      .map((space) => {
        const purpose = (space.instructions ?? "").replace(/\s+/gu, " ").trim()
        return `- ${space.name} (space_id ${space.space_id}): ${
          purpose.length === 0
            ? "no description; judge by its name"
            : cutText(purpose, CAPTURE_SPACE_TEXT_MAX)
        }`
      })
      .join("\n")
  )
