import { expandHome, isWithin } from "@arden-hq/std/paths"
import { homedir } from "node:os"
import path from "node:path"
import { canonicalRulePath } from "../fs/protected-paths.js"
import {
  caseFoldingDisk,
  neverRuleRefusal,
  pathRuleFor,
  type LocalPathPolicy
} from "../storage/local-paths.js"
import { toolRefusal } from "./tool-failure.js"
import type { PathAccess } from "../execution/rules.js"
import { parseCommandSegments } from "./bash-permissions.js"
import { isReadOnlyCommand, SHELL_FRAME } from "./bash-safe-commands.js"

export const refuseNeverPaths = async (
  command: string,
  cwd: string,
  policy: LocalPathPolicy
): Promise<void> => {
  const nevers = policy.pathRules.rules.flatMap((rule) =>
    rule.subject.kind === "path" && rule.decision === "never"
      ? [{ path: rule.subject.path, access: rule.subject.access }]
      : []
  )
  if (nevers.length === 0) return
  if (/\$['"]/u.test(command))
    throw unchecked("uses $'…' or $\"…\" quoting, which can spell any folder")
  if (/\bCDPATH\b/u.test(command)) throw unchecked("sets CDPATH, which moves cd anywhere")
  const segments =
    parseCommandSegments(command, { reading: "loose" }) ??
    command.split(/[\s;|&]+/u).map((word) => [word])
  const changes = !isReadOnlyCommand(parseCommandSegments(command), cwd)
  for (const never of nevers) {
    if (never.access === "change" && !changes) continue
    if (spellings(never.path).some((spelling) => spelling.test(command)))
      throw neverRuleRefusal(never.path, never.access)
  }
  let here = cwd
  const start = await namedPath(cwd, cwd)
  if (start !== undefined && pathRuleFor(policy, start, "read") === "never")
    throw neverRuleRefusal(start.real, "read")
  for (const words of segments) {
    const program = programWords(words)
    if (program[0] === "eval") throw unchecked("uses eval, whose words are read only when it runs")
    const flag = program.findIndex((word) => /^-[a-z]*c$/u.test(word))
    const body = SHELLS.has(program[0] ?? "") && flag > 0 ? program[flag + 1] : undefined
    if (body !== undefined) await refuseNeverPaths(body, here, policy)
    const partChanges = !isReadOnlyCommand([words], here)
    const bases = [here, ...(await optionFolders(words, here))]
    for (const [index, word] of words.entries()) {
      if (word === ">" || word === "<") continue
      const redirected = words[index - 1] === ">"
      const accesses: ReadonlyArray<PathAccess> =
        partChanges || redirected ? ["read", "change"] : ["read"]
      for (const candidate of pathWords(word)) {
        if (/^~[^/]/u.test(candidate))
          throw unchecked(`names ${candidate}, a home folder the check cannot read`)
        for (const base of bases) {
          const target = await namedPath(candidate, base)
          if (target === undefined) continue
          for (const access of accesses)
            if (pathRuleFor(policy, target, access) === "never")
              throw neverRuleRefusal(target.real, access)
          if (program.some((part) => LINKERS.has(path.basename(part)))) {
            const holds = nevers.find((never) => isWithin(target.real, never.path))
            if (holds !== undefined) throw neverRuleRefusal(holds.path, holds.access)
          }
        }
      }
    }
    here = await movedTo(program, here)
  }
}

const unchecked = (why: string) =>
  toolRefusal(
    `This command ${why}, so it cannot be checked against your never rules. Write the folder plainly.`,
    "Your rule"
  )

const LINKERS = new Set(["ln", "mount", "bindfs"])

const WRAPPERS = new Set([
  "builtin",
  "command",
  "exec",
  "env",
  "sudo",
  "xargs",
  "nohup",
  "nice",
  "time"
])

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])

const programWords = (segment: ReadonlyArray<string>): ReadonlyArray<string> => {
  let at = 0
  for (;;) {
    const word = segment[at] ?? ""
    if (SHELL_FRAME.has(word) || /^[A-Za-z_]\w*=/u.test(word)) at += 1
    else if (WRAPPERS.has(path.basename(word))) {
      at += 1
      while ((segment[at] ?? "").startsWith("-")) at += 1
    } else break
  }
  const [program, ...rest] = segment.slice(at)
  return program === undefined ? [] : [path.basename(program), ...rest]
}

const movedTo = async (segment: ReadonlyArray<string>, here: string): Promise<string> => {
  const [executable, ...rest] = segment
  if (executable === "popd") throw unchecked("uses popd, whose folder it cannot know")
  if (executable !== "cd" && executable !== "pushd") return here
  const operands = rest.filter((word) => !/^-[LPe@]+$/u.test(word) && word !== "--")
  const target = operands[0]
  if (target === undefined && executable === "pushd")
    throw unchecked("uses pushd with no folder, whose folder it cannot know")
  if (target === undefined) return homedir()
  if (target === "-" || /^[+-]\d+$/u.test(target))
    throw unchecked(`uses ${executable} ${target}, whose folder it cannot know`)
  const moved = await namedPath(target, here)
  if (moved === undefined) throw unchecked(`moves to ${target}, a folder it cannot read`)
  return moved.real
}

const FOLDER_OPTIONS = new Set(["-C", "--directory", "--chdir", "--work-tree", "--git-dir"])

const optionFolders = async (
  segment: ReadonlyArray<string>,
  here: string
): Promise<ReadonlyArray<string>> => {
  const named = segment.flatMap((word, index) => {
    if (FOLDER_OPTIONS.has(word))
      return segment[index + 1] === undefined ? [] : [segment[index + 1] ?? ""]
    const glued = /^(-C)(.+)$/u.exec(word) ?? /^(--[a-z-]+)=(.+)$/u.exec(word)
    return glued !== null && FOLDER_OPTIONS.has(glued[1] ?? "") ? [glued[2] ?? ""] : []
  })
  const folders = await Promise.all(named.map((folder) => namedPath(folder, here)))
  return folders.flatMap((folder) => (folder === undefined ? [] : [folder.real]))
}

const spellings = (folder: string): ReadonlyArray<RegExp> => {
  const home = homedir()
  const relative = path.relative(home, folder)
  const underHome = folder !== home && isWithin(home, folder)
  const forms = [
    folder,
    ...(underHome ? [`~/${relative}`, `$HOME/${relative}`, `\${HOME}/${relative}`] : [])
  ]
  const flags = caseFoldingDisk ? "iu" : "u"
  return forms.map(
    (form) => new RegExp(`${form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w.-])`, flags)
  )
}

const pathWords = (word: string): ReadonlyArray<string> => {
  const pieces = new Set<string>([word])
  const at = word.indexOf("=")
  if (at > 0) pieces.add(word.slice(at + 1))
  if (word.startsWith("-")) {
    const start = word.search(/[/~]/u)
    if (start > 0) pieces.add(word.slice(start))
  }
  if (/^-[^-]/u.test(word))
    for (let at = 2; at < Math.min(word.length, 16); at += 1) pieces.add(word.slice(at))
  for (const piece of [...pieces]) for (const part of piece.split(":")) pieces.add(part)
  return [...pieces].flatMap((piece) => expandBraces(piece, 64)).filter((piece) => piece !== "")
}

const numberRange = (range: RegExpExecArray, cap: number): ReadonlyArray<string> => {
  const from = Number(range[1])
  const to = Number(range[2])
  const step = to >= from ? 1 : -1
  return Array.from({ length: Math.min(cap, Math.abs(to - from) + 1) }, (_, at) =>
    String(from + at * step)
  )
}

/** `{a,b}`; undefined for braces with no comma, which the shell leaves as they are. */
const commaChoices = (inner: string): ReadonlyArray<string> | undefined =>
  inner.includes(",") ? inner.split(",") : undefined

const expandBraces = (word: string, cap: number): ReadonlyArray<string> => {
  const match = /\{([^{}]*)\}/u.exec(word)
  if (match === null) return [word]
  const inner = match[1] ?? ""
  const range = /^(-?\d+)\.\.(-?\d+)$/u.exec(inner)
  const choices = range ? numberRange(range, cap) : commaChoices(inner)
  if (choices === undefined) return [word]
  const before = word.slice(0, match.index)
  const after = word.slice(match.index + match[0].length)
  return choices.flatMap((choice) => expandBraces(`${before}${choice}${after}`, cap)).slice(0, cap)
}

const HOME_VARIABLE = /^\$(?:HOME|\{HOME\})(?=\/|$)/u

const namedPath = async (
  word: string,
  cwd: string
): Promise<{ readonly lexical: string; readonly real: string } | undefined> => {
  const trimmed = word.trim()
  if (trimmed.length === 0 || trimmed.startsWith("-")) return undefined
  if (trimmed.startsWith("file://")) return namedPath(trimmed.slice("file://".length), cwd)
  const lexical = path.resolve(cwd, expandHome(trimmed.replace(HOME_VARIABLE, "~"), homedir()))
  const real = await canonicalRulePath(lexical)
  if (real === undefined) return undefined
  return { lexical, real }
}
