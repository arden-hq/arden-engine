import { ASSISTANT_OUTPUT_PART_TYPE, type MessageIdMinter } from "@arden-hq/loop"

interface MintedPosition {
  readonly fragment: number
  readonly index: number
}

export const mintedTurnRoot = (assistantMessageId: string, turn: number): string =>
  turn === 0 ? assistantMessageId : `${assistantMessageId}-turn-${turn}`

export const mintedMessageId = (
  turnRoot: string,
  kind: Parameters<MessageIdMinter>[0],
  position: MintedPosition
): string => {
  const record = position.fragment === 0 ? turnRoot : `${turnRoot}-item-${position.fragment}`
  if (kind === ASSISTANT_OUTPUT_PART_TYPE.reasoning) {
    return position.index === 0
      ? `${record}-reasoning`
      : `${record}-reasoning-${position.index + 1}`
  }
  return position.index === 0 ? record : `${record}-text-${position.index + 1}`
}

export interface StreamedPart {
  readonly messageId: string
  readonly recordId: string | undefined
}

export const staleStreamedIds = (
  heldMessageIds: ReadonlySet<string>,
  streamed: ReadonlyArray<StreamedPart>
): ReadonlyArray<string> => [
  ...new Set(
    streamed.flatMap((part) =>
      part.recordId === undefined || heldMessageIds.has(part.recordId) ? [] : [part.messageId]
    )
  )
]
