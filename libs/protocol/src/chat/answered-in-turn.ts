/**
 * The rows of one turn, given in order, that Arden followed with prose the
 * reader sees (`isProse`): what arrived before Arden's last words in the turn
 * was answered there. A row with no prose after it (the turn failed, was held
 * or stopped, or ended in silence) was not.
 */
export const answeredInTurn = (
  rowIds: ReadonlyArray<string>,
  isProse: (id: string) => boolean
): ReadonlySet<string> => {
  const fromEnd = [...rowIds].reverse().findIndex(isProse)
  return new Set(fromEnd < 0 ? [] : rowIds.slice(0, rowIds.length - 1 - fromEnd))
}
