const PREFIX = "arden:memory/"

/** The app link that names a Memory page, such as arden:memory/projects/arden.md. */
export const memoryHref = (path: string): string =>
  `${PREFIX}${path.split("/").map(encodeURIComponent).join("/")}`

/** The arguments that name one saved Memory change in a wiki_read_change call. */
export const readChangeArgs = (path: string, at: string | undefined, offset = 0): string =>
  `page=${JSON.stringify(memoryHref(path))}${at === undefined ? "" : `, at=${JSON.stringify(at)}`}${offset === 0 ? "" : `, offset=${offset}`}`

/** The call that opens one saved change, as prompts and tool text show it to the model. */
export const readChangeCall = (path: string, at: string | undefined, offset = 0): string =>
  `wiki_read_change(${readChangeArgs(path, at, offset)})`

/** The page path a Memory link names; text that is not a link is taken as the path. */
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
