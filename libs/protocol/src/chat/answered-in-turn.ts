export const answeredInTurn = (
  rowIds: ReadonlyArray<string>,
  isProse: (id: string) => boolean
): ReadonlySet<string> => {
  const fromEnd = [...rowIds].reverse().findIndex(isProse)
  return new Set(fromEnd < 0 ? [] : rowIds.slice(0, rowIds.length - 1 - fromEnd))
}
