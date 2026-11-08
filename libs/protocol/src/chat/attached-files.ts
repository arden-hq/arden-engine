/** Files attached to a chat message by reference travel in its text: one
 *  `Attached: <absolute path>` line each, in one block at the end, after a
 *  blank line (or as the whole message). The agent reads each file from its
 *  path; the server keeps an upload while a message names it. A folder's path
 *  ends in "/".
 *
 *  This is the one writer and the one reader of that block. Only a strict
 *  trailing block is read back: a line that does not hold an absolute path,
 *  or an `Attached:` line with words after it, stays text. */

const PREFIX = "Attached: "

/** A file a message names by its path. */
export interface AttachedFileRef {
  readonly path: string
  /** The last part of the path: the file or folder name. */
  readonly name: string
  readonly directory: boolean
}

/** A message split into the words the sender typed and the files it names. */
export interface SplitAttachedFiles {
  readonly text: string
  readonly files: ReadonlyArray<AttachedFileRef>
}

/** The text with each file's absolute path on its own line after it. */
export const withAttachedFiles = (
  text: string,
  files: ReadonlyArray<{ readonly path: string; readonly directory: boolean }>
): string => {
  if (files.length === 0) return text
  const lines = files
    .map(
      (file) =>
        `${PREFIX}${file.directory && !file.path.endsWith("/") ? `${file.path}/` : file.path}`
    )
    .join("\n")
  return text.trim().length === 0 ? lines : `${text.trimEnd()}\n\n${lines}`
}

const refOf = (line: string): AttachedFileRef | undefined => {
  if (!line.startsWith(PREFIX)) return undefined
  const raw = line.slice(PREFIX.length)
  if (!raw.startsWith("/") || raw.length < 2 || raw !== raw.trim()) return undefined
  const directory = raw.endsWith("/")
  const path = directory ? raw.slice(0, -1) : raw
  const name = path.slice(path.lastIndexOf("/") + 1)
  return name ? { path, name, directory } : undefined
}

const NONE: SplitAttachedFiles["files"] = []

/** The typed words and the attached files of a stored message. A message with
 *  no strict trailing block comes back whole, with no files. */
export const splitAttachedFiles = (content: string): SplitAttachedFiles => {
  const lines = content.replace(/\s+$/, "").split("\n")
  let start = lines.length
  while (start > 0 && refOf(lines[start - 1] ?? "") !== undefined) start -= 1
  if (start === lines.length) return { text: content, files: NONE }
  if (start > 0 && (lines[start - 1] ?? "").trim() !== "") return { text: content, files: NONE }
  const files = lines.slice(start).flatMap((line) => refOf(line) ?? [])
  return { text: lines.slice(0, start).join("\n").trimEnd(), files }
}

/** The attached files' names, as a person reads them: "a.pdf, Taxes 2026". */
export const attachedFileNames = (files: ReadonlyArray<AttachedFileRef>): string =>
  files.map((file) => file.name).join(", ")

/** A stored message as the words a one-line preview shows: the path lines
 *  give way to the files' names, after the typed words. A message with no
 *  attached files comes back unchanged. */
export const withFileNames = (content: string): string => {
  const { text, files } = splitAttachedFiles(content)
  if (files.length === 0) return content
  const names = attachedFileNames(files)
  return text.length === 0 ? names : `${text} (${names})`
}
