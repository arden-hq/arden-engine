import type { ModelCapabilities } from "@arden-hq/loop"
import type { ModelDefinition } from "./host.js"

const THINKING_OFF = "none"

export const REASONING_ALLOWANCE_TOKENS = 4_096

export type OutputLimitDelivery = NonNullable<ModelCapabilities["outputLimit"]>

export const outputLimitDelivery = (capabilities: ModelCapabilities): OutputLimitDelivery =>
  capabilities.outputLimit ?? "sent"

export const sideCallEffort = ({
  assigned,
  declared,
  delivery
}: {
  readonly assigned: string | undefined
  readonly declared: ReadonlyArray<string>
  readonly delivery: OutputLimitDelivery
}): string | undefined =>
  assigned ?? (delivery === "sent" && declared.includes(THINKING_OFF) ? THINKING_OFF : undefined)

export const sideCallOutputLimit = ({
  answerTokens,
  effort,
  outputCap
}: {
  readonly answerTokens: number
  readonly effort: string | undefined
  readonly outputCap: number | undefined
}): number =>
  Math.min(
    effort === THINKING_OFF ? answerTokens : answerTokens + REASONING_ALLOWANCE_TOKENS,
    outputCap ?? Number.POSITIVE_INFINITY
  )

export const chatStepOutputLimit = ({
  context,
  delivery
}: {
  readonly context: ModelDefinition["context"]
  readonly delivery: OutputLimitDelivery
}): number | undefined => {
  if (delivery === "omitted") return undefined
  const room = context.hardLimit - context.compactionTrigger
  if (room < 1) return context.outputCap
  return Math.min(room, context.outputCap ?? Number.POSITIVE_INFINITY)
}
