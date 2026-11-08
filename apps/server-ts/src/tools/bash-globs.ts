import { readdirSync } from "node:fs"
import { unquotedGlobWords } from "./bash-permissions.js"

/**
 * Whether the shell could turn a word of a parsed segment into a flag: an
 * unquoted glob expands against the folder the command runs in, and a file
 * named `-delete` or `--pre=x` there becomes that flag.
 */

const mayStartWithDash = (word: string): boolean => /^[-*?[\\]/.test(word)

const holdsFlagNamedFile = (cwd: string): boolean => {
  try {
    return readdirSync(cwd).some((name) => name.startsWith("-"))
  } catch {
    return true
  }
}

export const globsIntoFlag = (segment: ReadonlyArray<string>, cwd: string): boolean => {
  const globbed = unquotedGlobWords(segment)
  for (const at of globbed) if (mayStartWithDash(segment[at] ?? "")) return holdsFlagNamedFile(cwd)
  return false
}

const FRAME = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"])

export const changesFolder = (segment: ReadonlyArray<string>): boolean => {
  const command = segment.find((word) => !FRAME.has(word))
  return command === "cd" || command === "pushd" || command === "popd"
}

export const hasGlob = (segment: ReadonlyArray<string>): boolean =>
  unquotedGlobWords(segment).size > 0
