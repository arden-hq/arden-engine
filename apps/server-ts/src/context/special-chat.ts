import { Option, Schema } from "effect"
import { PROMPTS } from "../prompts/catalog.js"
import { cutText } from "@arden-hq/std/text"
import { renderPromptSection } from "../prompts/format.js"
import { SPACE_KIND, type SpaceKind } from "@arden-hq/protocol/spaces"

export const SPECIAL_CHAT_KIND = { capture: "capture", onboarding: "onboarding" } as const

type SpecialChatKind = (typeof SPECIAL_CHAT_KIND)[keyof typeof SPECIAL_CHAT_KIND]

export interface SpecialChat {
  readonly kind: SpecialChatKind
  readonly context: string
}

const MarkSchema = Schema.Struct({ at: Schema.String })
const marked = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(MarkSchema)(value))

export const readSpecialChat = (
  metadata: Readonly<Record<string, unknown>>
): SpecialChat | undefined => {
  if (marked(metadata["capture"]))
    return {
      kind: SPECIAL_CHAT_KIND.capture,
      context: renderPromptSection("Handed capture", PROMPTS.capture)
    }
  if (marked(metadata["onboarding"]))
    return {
      kind: SPECIAL_CHAT_KIND.onboarding,
      context: renderPromptSection("Getting started", PROMPTS.onboarding)
    }
  return undefined
}

const CAPTURE_SPACE_TEXT_MAX = 300

export const renderCaptureSpaces = ({
  spaces,
  chatInMain
}: {
  readonly spaces: ReadonlyArray<{
    readonly space_id: string
    readonly kind: SpaceKind
    readonly name: string
    readonly instructions: string | null
  }>
  readonly chatInMain: boolean
}): string =>
  renderPromptSection(
    "Spaces to file it under",
    [
      chatInMain ? "This chat is in the Main Space." : "This chat is already on a Space.",
      ...spaces
        .filter((space) => space.kind !== SPACE_KIND.main)
        .map((space) => {
          const purpose = (space.instructions ?? "").replace(/\s+/gu, " ").trim()
          return `- ${space.name} (space_id ${space.space_id}): ${
            purpose.length === 0
              ? "no description; judge by its name"
              : cutText(purpose, CAPTURE_SPACE_TEXT_MAX)
          }`
        })
    ].join("\n")
  )
