const PREFIX = "arden:memory/"

export const memoryHref = (path: string): string =>
  `${PREFIX}${path.split("/").map(encodeURIComponent).join("/")}`

export const readChangeArgs = (path: string, at: string | undefined, offset = 0): string =>
  `page=${JSON.stringify(memoryHref(path))}${at === undefined ? "" : `, at=${JSON.stringify(at)}`}${offset === 0 ? "" : `, offset=${offset}`}`

export const readChangeCall = (path: string, at: string | undefined, offset = 0): string =>
  `wiki_read_change(${readChangeArgs(path, at, offset)})`

export const memoryPathOf = (linkOrPath: string): string => {
  const text = linkOrPath.trim()
  if (!text.startsWith(PREFIX)) return text
  return text
    .slice(PREFIX.length)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
    .join("/")
}
