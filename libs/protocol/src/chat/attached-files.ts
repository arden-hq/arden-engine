const PREFIX = "Attached: "

export interface AttachedFileRef {
  readonly path: string
  readonly name: string
  readonly directory: boolean
}

export interface SplitAttachedFiles {
  readonly text: string
  readonly files: ReadonlyArray<AttachedFileRef>
}

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

export const splitAttachedFiles = (content: string): SplitAttachedFiles => {
  const lines = content.replace(/\s+$/, "").split("\n")
  let start = lines.length
  while (start > 0 && refOf(lines[start - 1] ?? "") !== undefined) start -= 1
  if (start === lines.length) return { text: content, files: NONE }
  if (start > 0 && (lines[start - 1] ?? "").trim() !== "") return { text: content, files: NONE }
  const files = lines.slice(start).flatMap((line) => refOf(line) ?? [])
  return { text: lines.slice(0, start).join("\n").trimEnd(), files }
}

export const attachedFileNames = (files: ReadonlyArray<AttachedFileRef>): string =>
  files.map((file) => file.name).join(", ")

export const withFileNames = (content: string): string => {
  const { text, files } = splitAttachedFiles(content)
  if (files.length === 0) return content
  const names = attachedFileNames(files)
  return text.length === 0 ? names : `${text} (${names})`
}
