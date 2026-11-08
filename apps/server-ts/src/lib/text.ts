export const textBefore = (text: string, separator: string): string => {
  const end = text.indexOf(separator)
  return end === -1 ? text : text.slice(0, end)
}
