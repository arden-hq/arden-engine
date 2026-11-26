import { toolDisplayTitle } from "@arden-hq/std/text"
import type { ToolDisplayTitle } from "../contracts/tools.js"
import { isRecord } from "@arden-hq/std/json"

export const withToolDisplayTitleParameter = (
  parameters: Readonly<Record<string, unknown>>,
  toolName: string,
  displayTitle: ToolDisplayTitle
): Readonly<Record<string, unknown>> => {
  const current = parameters.properties
  if (current !== undefined && !isRecord(current)) {
    throw new TypeError(`Tool '${toolName}' has non-object JSON Schema properties`)
  }
  const properties = current ?? {}
  if (Object.hasOwn(properties, displayTitle.argument)) {
    throw new TypeError(`Tool '${toolName}' uses reserved argument '${displayTitle.argument}'`)
  }
  const required = parameters.required ?? []
  if (!Array.isArray(required)) {
    throw new TypeError(`Tool '${toolName}' has a non-array JSON Schema required list`)
  }
  return {
    ...parameters,
    properties: {
      [displayTitle.argument]: {
        type: "string",
        maxLength: displayTitle.maxLength,
        description:
          'What this call is doing, in 2-6 words in the -ing form, naming the specific thing: "Reading the Kev notes", "Searching for RunPod pricing". Shown to the user; it does not change what the tool does.'
      },
      ...properties
    },
    required: [displayTitle.argument, ...required]
  }
}

export const sanitizeToolDisplayTitle = (
  value: unknown,
  displayTitle: ToolDisplayTitle
): string | undefined => toolDisplayTitle(value, displayTitle.maxLength)

export interface SplitToolArguments {
  readonly args: Readonly<Record<string, unknown>>
  readonly displayTitle?: string
}

export const splitToolArguments = (
  args: Readonly<Record<string, unknown>>,
  persistedTitle: unknown,
  displayTitle: ToolDisplayTitle | undefined
): SplitToolArguments => {
  if (displayTitle === undefined) return { args }
  const title =
    sanitizeToolDisplayTitle(args[displayTitle.argument], displayTitle) ??
    sanitizeToolDisplayTitle(persistedTitle, displayTitle)
  const behaviorArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== displayTitle.argument)
  )
  return {
    args: behaviorArgs,
    ...(title === undefined ? {} : { displayTitle: title })
  }
}
