type MintedKind = "text" | "reasoning"

interface MintedPosition {
  readonly fragment: number
  readonly index: number
}

export const mintedTurnRoot = (assistantMessageId: string, turn: number): string =>
  turn === 0 ? assistantMessageId : `${assistantMessageId}-turn-${turn}`

export const mintedMessageId = (
  turnRoot: string,
  kind: MintedKind,
  position: MintedPosition
): string => {
  const record = position.fragment === 0 ? turnRoot : `${turnRoot}-item-${position.fragment}`
  if (kind === "reasoning") {
    return position.index === 0
      ? `${record}-reasoning`
      : `${record}-reasoning-${position.index + 1}`
  }
  return position.index === 0 ? record : `${record}-text-${position.index + 1}`
}

export const isRunMinted = (assistantMessageId: string, messageId: string): boolean =>
  messageId === assistantMessageId || messageId.startsWith(`${assistantMessageId}-`)

const streamedRecordId = (messageId: string): string =>
  messageId.replace(/-(?:reasoning(?:-\d+)?|text-\d+)$/, "")

export const staleStreamedIds = (
  assistantMessageId: string,
  heldMessageIds: ReadonlySet<string>,
  streamedIds: ReadonlyArray<string>
): ReadonlyArray<string> => [
  ...new Set(
    streamedIds.filter(
      (id) => isRunMinted(assistantMessageId, id) && !heldMessageIds.has(streamedRecordId(id))
    )
  )
]
