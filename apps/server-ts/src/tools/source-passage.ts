import { markdownWords } from "@arden-hq/protocol/chat"
import { cutText } from "@arden-hq/std/text"
type SourceUse = "read" | "found" | "work"

export interface SourcePassage {
  readonly use: SourceUse
  readonly excerpt?: string
  readonly at?: string
  readonly href?: string
}

const PASSAGE_CHARS = 320

export const unquotedEmail = (body: string): string => {
  const lines: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()))
      break
    if (line.trimStart().startsWith(">")) continue
    lines.push(line)
  }
  return lines.join("\n")
}

export const passage = (text: string, max = PASSAGE_CHARS): string | undefined => {
  const plain = markdownWords(text)
  if (plain.length === 0) return undefined
  if (plain.length <= max) return plain
  return cutText(plain, max, { atWord: true })
}
