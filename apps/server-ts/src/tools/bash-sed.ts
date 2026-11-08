/** Long options that only change how sed reads or prints. Exact names only:
 *  GNU accepts any unambiguous prefix, and none of those is accepted here. */
const SAFE_LONG = new Set([
  "--quiet",
  "--silent",
  "--regexp-extended",
  "--posix",
  "--null-data",
  "--unbuffered",
  "--debug",
  "--sandbox"
])
const SAFE_SHORT = new Set(["n", "E", "r", "z", "u"])

const sedScripts = (args: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const scripts: string[] = []
  let options = true
  let bare = false
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ""
    if (options && token === "--") {
      options = false
      continue
    }
    if (options && token.startsWith("--")) {
      if (SAFE_LONG.has(token)) continue
      if (token === "--expression" || token === "--line-length") {
        const value = args[index + 1]
        if (value === undefined) return undefined
        if (token === "--expression") scripts.push(value)
        else if (!/^\d+$/.test(value)) return undefined
        index += 1
        continue
      }
      if (token.startsWith("--expression=")) {
        scripts.push(token.slice("--expression=".length))
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
      if (letter !== "e" && letter !== "l") return undefined
      const rest = token.slice(at + 1)
      const value = rest !== "" ? rest : args[(index += 1)]
      if (value === undefined) return undefined
      if (letter === "e") scripts.push(value)
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
    const d = delimiter === "|" ? String.raw`\|` : delimiter
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
    if (rest[0] !== ";" && rest[0] !== "\n") return false
    rest = rest.slice(1)
    if (rest.trim() === "") return true
  }
}

export const sedReadsOnly = (args: ReadonlyArray<string>): boolean => {
  const scripts = sedScripts(args)
  return scripts !== undefined && scripts.every(safeScript)
}
