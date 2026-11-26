import { OPTION, SHELL_CHARACTER, type ShellCharacter } from "./shell-words.js"

const SED_OPTION = {
  quiet: "--quiet",
  silent: "--silent",
  regexpExtended: "--regexp-extended",
  posix: "--posix",
  nullData: "--null-data",
  unbuffered: "--unbuffered",
  debug: "--debug",
  sandbox: "--sandbox",
  expression: "--expression",
  lineLength: "--line-length"
} as const
type SedOption = (typeof SED_OPTION)[keyof typeof SED_OPTION]

const SED_LETTER = {
  quiet: "n",
  extended: "E",
  regexpExtended: "r",
  nullData: "z",
  unbuffered: "u",
  expression: "e",
  lineLength: "l"
} as const
type SedLetter = (typeof SED_LETTER)[keyof typeof SED_LETTER]

const SCRIPT_SEPARATORS: ReadonlySet<string> = new Set<ShellCharacter>([
  SHELL_CHARACTER.semicolon,
  SHELL_CHARACTER.newline
])

const SAFE_LONG: ReadonlySet<string> = new Set<SedOption>([
  SED_OPTION.quiet,
  SED_OPTION.silent,
  SED_OPTION.regexpExtended,
  SED_OPTION.posix,
  SED_OPTION.nullData,
  SED_OPTION.unbuffered,
  SED_OPTION.debug,
  SED_OPTION.sandbox
])
const SAFE_SHORT: ReadonlySet<string> = new Set<SedLetter>([
  SED_LETTER.quiet,
  SED_LETTER.extended,
  SED_LETTER.regexpExtended,
  SED_LETTER.nullData,
  SED_LETTER.unbuffered
])

const sedScripts = (args: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const scripts: string[] = []
  let options = true
  let bare = false
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ""
    if (options && token === OPTION.end) {
      options = false
      continue
    }
    if (options && token.startsWith("--")) {
      if (SAFE_LONG.has(token)) continue
      if (token === SED_OPTION.expression || token === SED_OPTION.lineLength) {
        const value = args[index + 1]
        if (value === undefined) return undefined
        if (token === SED_OPTION.expression) scripts.push(value)
        else if (!/^\d+$/.test(value)) return undefined
        index += 1
        continue
      }
      if (token.startsWith(`${SED_OPTION.expression}=`)) {
        scripts.push(token.slice(SED_OPTION.expression.length + 1))
        continue
      }
      if (/^--line-length=\d+$/.test(token)) continue
      return undefined
    }
    if (options && token.startsWith("-") && token.length > 1) {
      let at = 1
      while (at < token.length && SAFE_SHORT.has(token[at] ?? "")) at += 1
      if (at === token.length) continue
      const letter = token[at]
      if (letter !== SED_LETTER.expression && letter !== SED_LETTER.lineLength) return undefined
      const rest = token.slice(at + 1)
      const value = rest !== "" ? rest : args[(index += 1)]
      if (value === undefined) return undefined
      if (letter === SED_LETTER.expression) scripts.push(value)
      else if (!/^\d+$/.test(value)) return undefined
      continue
    }
    if (scripts.length === 0 && !bare) {
      scripts.push(token)
      bare = true
    }
  }
  return scripts.length === 0 ? undefined : scripts
}

const REGEX_BODY = String.raw`(?:[^/\\\[\n]|\\[^\n])*`
const ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|\/${REGEX_BODY}\/I?)`
const RANGE_END = String.raw`(?:${ADDRESS}|[+~]\d+)`
const SIMPLE = String.raw`(?:[pP=dDnN]|[qQ]\d*|l\d*)`
const SUBSTITUTE = ["/", "|", "#", ",", ":", "@"]
  .map((delimiter) => {
    const d = delimiter === SHELL_CHARACTER.pipe ? String.raw`\|` : delimiter
    const body = String.raw`(?:[^${d}\\\[\n]|\\[^\n])*`
    return String.raw`s${d}${body}${d}${body}${d}[gpiI0-9]*`
  })
  .join("|")
const COMMAND = new RegExp(
  String.raw`^\s*(?:${ADDRESS}(?:\s*,\s*${RANGE_END})?\s*)?(?:!\s*)?(?:${SIMPLE}|${SUBSTITUTE})\s*`
)
const SCRIPT_LIMIT = 4_000

const safeScript = (script: string): boolean => {
  if (script.length > SCRIPT_LIMIT) return false
  let rest = script
  for (;;) {
    const match = COMMAND.exec(rest)
    if (match === null) return false
    rest = rest.slice(match[0].length)
    if (rest === "") return true
    if (!SCRIPT_SEPARATORS.has(rest[0] ?? "")) return false
    rest = rest.slice(1)
    if (rest.trim() === "") return true
  }
}

export const sedReadsOnly = (args: ReadonlyArray<string>): boolean => {
  const scripts = sedScripts(args)
  return scripts !== undefined && scripts.every(safeScript)
}
