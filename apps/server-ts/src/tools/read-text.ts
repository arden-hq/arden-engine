export interface TextPage {
  readonly content: string
  readonly notice: string
  readonly total: number
  readonly shown: number
  readonly hasMore: boolean
}

export function readTextPage(
  content: string,
  options: {
    readonly offset: number
    readonly limit: number
    readonly format?: "plain" | "numbered"
  }
): TextPage {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const start = Math.min(options.offset - 1, lines.length)
  const selected = lines.slice(start, start + options.limit)
  const end = start + selected.length
  const hasMore = end < lines.length
  const notice =
    selected.length === 0
      ? `[No lines at offset ${options.offset}; ${lines.length} lines total.]`
      : `[Showing lines ${start + 1}-${end} of ${lines.length}.${hasMore ? ` Use offset=${end + 1} to continue.` : " End of content."}]`
  return {
    content:
      options.format === "numbered"
        ? selected.map((line, index) => `${start + index + 1}|${line}`).join("")
        : selected.join(""),
    notice: options.offset === 1 && !hasMore ? "" : notice,
    total: lines.length,
    shown: selected.length,
    hasMore
  }
}
