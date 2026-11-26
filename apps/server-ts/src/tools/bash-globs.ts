import { readdirSync } from "node:fs"
import { unquotedGlobWords } from "./shell-parse.js"
import { COMMAND, SHELL_FRAME, type Command } from "./shell-words.js"

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

const FOLDER_CHANGERS: ReadonlySet<string> = new Set<Command>([
  COMMAND.cd,
  COMMAND.pushd,
  COMMAND.popd
])

export const changesFolder = (segment: ReadonlyArray<string>): boolean => {
  const command = segment.find((word) => !SHELL_FRAME.has(word))
  return command !== undefined && FOLDER_CHANGERS.has(command)
}

export const hasGlob = (segment: ReadonlyArray<string>): boolean =>
  unquotedGlobWords(segment).size > 0
