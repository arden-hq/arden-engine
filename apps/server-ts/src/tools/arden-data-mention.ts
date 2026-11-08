import { isWithin } from "@arden-hq/std/paths"
import { homedir } from "node:os"
import path from "node:path"

import { ardenStateRoot } from "../storage/local-paths.js"

export const ardenDataRoots = (dataDir: string): ReadonlyArray<string> => [
  ...new Set([path.resolve(dataDir), ardenStateRoot(dataDir)])
]

const PATH_CHARACTER = /[A-Za-z0-9_.\-/~$]/

const spellings = (root: string, home: string, cwd: string): ReadonlyArray<string> => {
  const fromHome =
    root !== home && isWithin(home, root)
      ? path.relative(home, root).split(path.sep).join("/")
      : undefined
  const fromCwd =
    root !== cwd && isWithin(cwd, root)
      ? path.relative(cwd, root).split(path.sep).join("/")
      : undefined
  return [
    root,
    ...(fromHome === undefined
      ? []
      : [`~/${fromHome}`, `$HOME/${fromHome}`, `\${HOME}/${fromHome}`]),
    ...(fromCwd === undefined ? [] : [fromCwd, `./${fromCwd}`])
  ]
}

const standsAlone = (text: string, start: number, end: number): boolean => {
  const before = text[start - 1]
  const after = text[end]
  return (
    (before === undefined || !PATH_CHARACTER.test(before)) &&
    (after === undefined || after === "/" || !PATH_CHARACTER.test(after))
  )
}

const contains = (text: string, spelling: string): boolean => {
  for (let from = text.indexOf(spelling); from !== -1; from = text.indexOf(spelling, from + 1)) {
    if (standsAlone(text, from, from + spelling.length)) return true
  }
  return false
}

export const mentionsArdenData = (input: {
  readonly command: string
  readonly cwd: string
  readonly roots: ReadonlyArray<string>
  readonly home?: string
}): boolean => {
  const home = input.home ?? homedir()
  if (input.roots.some((root) => isWithin(root, input.cwd))) return true
  const text = input.command.replaceAll(/["']/g, "").toLowerCase()
  return input.roots.some((root) =>
    spellings(root, home, input.cwd).some((spelling) => contains(text, spelling.toLowerCase()))
  )
}
