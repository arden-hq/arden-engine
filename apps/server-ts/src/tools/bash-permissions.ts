import { constants } from "node:fs"
import { access, realpath } from "node:fs/promises"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import {
  commandDisplayPrefix,
  type CommandPolicyRule,
  type CommandGrantOffer
} from "../persistence/permissions/command-policy.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"

const NEVER_REUSABLE = new Set([
  "bash",
  "chmod",
  "chown",
  "dash",
  "dd",
  "deno",
  "env",
  "fdisk",
  "fish",
  "julia",
  "ksh",
  "lua",
  "mkfs",
  "node",
  "nodejs",
  "osascript",
  "perl",
  "php",
  "powershell",
  "powershell.exe",
  "pwsh",
  "py",
  "pypy",
  "pypy3",
  "python",
  "python3",
  "pythonw",
  "rm",
  "ruby",
  "sh",
  "sudo",
  "xargs",
  "zsh"
])

const SUBCOMMAND_DEPTH: Readonly<Record<string, number>> = {
  aws: 2,
  az: 2,
  bun: 1,
  cargo: 1,
  docker: 1,
  gcloud: 2,
  gh: 2,
  git: 1,
  helm: 1,
  kubectl: 1,
  npm: 1,
  pnpm: 1,
  podman: 1,
  terraform: 1,
  yarn: 1
}

export interface HostCommandGrantPlan {
  readonly rule: RuleDecision | undefined
  readonly offer?: CommandGrantOffer
  readonly displayPrefixes: ReadonlyArray<string>
}

const finishToken = (tokens: string[], token: string): string => {
  if (token.length > 0) tokens.push(token)
  return ""
}

interface WordSyntax {
  readonly glob: ReadonlySet<number>
  readonly expansion: boolean
}
const WORD_SYNTAX = new WeakMap<ReadonlyArray<string>, WordSyntax>()
const NO_GLOBS: ReadonlySet<number> = new Set()

export const unquotedGlobWords = (segment: ReadonlyArray<string>): ReadonlySet<number> =>
  WORD_SYNTAX.get(segment)?.glob ?? NO_GLOBS

export const hasShellExpansion = (segment: ReadonlyArray<string>): boolean =>
  WORD_SYNTAX.get(segment)?.expansion ?? false

export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

interface Expansion {
  readonly word: string
  readonly end: number
  readonly runs: string | undefined
}

const closing = (command: string, start: number, open: string, close: string): number => {
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < command.length; index += 1) {
    const character = command[index]
    if (character === "\\" && quote !== "'") index += 1
    else if (quote !== undefined) {
      if (character === quote) quote = undefined
    } else if (character === "'" || character === '"') quote = character
    else if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const expansionAt = (command: string, index: number): Expansion | undefined => {
  if (command[index] === "`") {
    let end = index + 1
    while (end < command.length && command[end] !== "`") end += command[end] === "\\" ? 2 : 1
    if (end >= command.length) return undefined
    return { word: "`…`", end, runs: command.slice(index + 1, end) }
  }
  const next = command[index + 1]
  if (next === "'") {
    let end = index + 2
    while (end < command.length && command[end] !== "'") end += command[end] === "\\" ? 2 : 1
    if (end >= command.length) return undefined
    return { word: command.slice(index + 2, end).replace(/\\(.)/g, "$1"), end, runs: undefined }
  }
  if (next === "(") {
    const end = closing(command, index + 1, "(", ")")
    if (end === -1) return undefined
    const arithmetic = command[index + 2] === "("
    return { word: "$(…)", end, runs: arithmetic ? undefined : command.slice(index + 2, end) }
  }
  if (next === "{") {
    const end = closing(command, index + 1, "{", "}")
    if (end === -1) return undefined
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(index + 2, end))?.[0] ?? ""
    return { word: `\${${name}}`, end, runs: undefined }
  }
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?@*#!$-])/.exec(command.slice(index + 1))?.[0]
  return name === undefined
    ? { word: "$", end: index, runs: undefined }
    : { word: `$${name}`, end: index + name.length, runs: undefined }
}

interface HereDocument {
  readonly delimiter: string
  readonly tabs: boolean
  readonly quoted: boolean
  readonly words: string[]
  readonly at: number
}

const hereDocumentBody = (
  command: string,
  from: number,
  document: HereDocument
): { readonly body: string; readonly end: number } => {
  let start = from + 1
  while (start < command.length) {
    const newline = command.indexOf("\n", start)
    const end = newline === -1 ? command.length : newline
    const line = command.slice(start, end)
    if ((document.tabs ? line.replace(/^\t+/, "") : line) === document.delimiter)
      return { body: command.slice(from + 1, start), end: end - 1 }
    start = end + 1
  }
  return { body: command.slice(from + 1), end: command.length - 1 }
}

export const parseCommandSegments = (
  command: string,
  {
    reading = "exact",
    environment
  }: {
    readonly reading?: "exact" | "loose"
    readonly environment?: NodeJS.ProcessEnv
  } = {}
): ReadonlyArray<ReadonlyArray<string>> | undefined => {
  const loose = reading === "loose"
  const unchanged = (word: string): boolean => {
    const at = word.indexOf("=")
    return environment !== undefined && environment[word.slice(0, at)] === word.slice(at + 1)
  }
  const segments: string[][] = []
  let tokens: string[] = []
  let token = ""
  let quote: "single" | "double" | undefined
  let escaped = false
  let afterOperator = false
  const hereDocuments: HereDocument[] = []
  let tokenGlob = false
  let globs: number[] = []
  let expansion = false
  let braces = 0
  const finishWord = (): string => {
    if (token.length > 0 && tokenGlob) globs.push(tokens.length)
    tokenGlob = false
    braces = 0
    return finishToken(tokens, token)
  }
  const dropFirst = (): void => {
    tokens.shift()
    globs = globs.map((at) => at - 1).filter((at) => at >= 0)
  }

  const finishSegment = (): boolean => {
    token = finishWord()
    if (loose) while (tokens[0] !== undefined && ASSIGNMENT.test(tokens[0])) dropFirst()
    while (tokens[0] !== undefined && ASSIGNMENT.test(tokens[0]) && unchanged(tokens[0]))
      dropFirst()
    const [first] = tokens
    if (first === undefined && (!loose || !expansion)) return loose
    if (first !== undefined && ASSIGNMENT.test(first)) return false
    WORD_SYNTAX.set(tokens, { glob: new Set(globs), expansion })
    segments.push(tokens)
    tokens = []
    globs = []
    expansion = false
    afterOperator = true
    return true
  }

  const nested = (inner: string): void => {
    segments.push(["("])
    for (const part of parseCommandSegments(inner, {
      reading,
      ...(environment === undefined ? {} : { environment })
    }) ?? []) {
      const copy = [...part]
      const inner = WORD_SYNTAX.get(part)
      if (inner !== undefined) WORD_SYNTAX.set(copy, inner)
      segments.push(copy)
    }
    segments.push([")"])
  }

  const expand = (index: number): number | undefined => {
    const read = expansionAt(command, index)
    if (read === undefined) return undefined
    expansion = true
    token += read.word
    afterOperator = false
    if (read.runs !== undefined) nested(read.runs)
    return read.end
  }

  for (let index = 0; ; index += 1) {
    const character = command[index]
    if (character === undefined) break
    if (escaped) {
      if (!(loose && character === "\n")) token += character
      escaped = false
      afterOperator = false
      continue
    }
    if (quote === "single") {
      if (character === "'") quote = undefined
      else token += character
      continue
    }
    if (quote === "double") {
      if (character === '"') quote = undefined
      else if (character === "\\") escaped = true
      else if (character === "$" || character === "`") {
        const end = loose ? expand(index) : undefined
        if (end === undefined) return undefined
        index = end
      } else token += character
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === "'") {
      quote = "single"
      afterOperator = false
      continue
    }
    if (character === '"') {
      quote = "double"
      afterOperator = false
      continue
    }
    if (loose) {
      const next = command[index + 1]
      if (character === "$" || character === "`") {
        const end = expand(index)
        if (end === undefined) return undefined
        index = end
        continue
      }
      if (character === "#" && token.length === 0) {
        const end = command.indexOf("\n", index)
        if (end === -1) break
        index = end - 1
        continue
      }
      if ((character === "<" || character === ">") && next === "(") {
        const end = closing(command, index + 1, "(", ")")
        if (end === -1) return undefined
        token += `${character}(…)`
        nested(command.slice(index + 2, end))
        index = end
        continue
      }
      if (character === "<" && next === "<" && command[index + 2] !== "<") {
        const word = /^<<(-?)\s*(['"]?)([^\s'"<>|&;()]+)\2/.exec(command.slice(index))
        const delimiter = word?.[3]
        if (word === null || delimiter === undefined) return undefined
        token = finishWord()
        tokens.push("<", "")
        hereDocuments.push({
          delimiter,
          tabs: word[1] === "-",
          quoted: word[2] !== "",
          words: tokens,
          at: tokens.length - 1
        })
        index += word[0].length - 1
        continue
      }
      if (character === ">" || character === "<" || (character === "&" && next === ">")) {
        if (/^\d+$/.test(token)) {
          token = ""
          tokenGlob = false
        } else token = finishWord()
        while (/[<>|&]/.test(command[index + 1] ?? "")) index += 1
        tokens.push(character === "<" ? "<" : ">")
        afterOperator = false
        continue
      }
      if (character === "\n" && hereDocuments.length > 0) {
        finishSegment()
        for (const document of hereDocuments.splice(0)) {
          const read = hereDocumentBody(command, index, document)
          document.words[document.at] = read.body
          if (!document.quoted) {
            for (let at = 0; at < read.body.length; at += 1) {
              const character = read.body[at]
              if (character === "\\") at += 1
              else if (character === "$" || character === "`") {
                WORD_SYNTAX.set(document.words, {
                  glob: unquotedGlobWords(document.words),
                  expansion: true
                })
                break
              }
            }
          }
          index = read.end + 1
        }
        continue
      }
      const group =
        token.length === 0 &&
        ((character === "{" && (next === undefined || /\s/.test(next))) ||
          (character === "}" && (next === undefined || /[\s;|&)]/.test(next))))
      if (character === "(" || character === ")" || group || (character === "&" && next !== "&")) {
        finishSegment()
        if (character === "(" || character === ")") segments.push([character])
        continue
      }
      if (character === "{" || character === "}") {
        braces = character === "{" ? braces + 1 : Math.max(0, braces - 1)
        token += character
        continue
      }
    }
    if (
      character === "$" ||
      character === "`" ||
      character === "#" ||
      character === ">" ||
      character === "<" ||
      character === "(" ||
      character === ")" ||
      character === "{" ||
      character === "}"
    ) {
      return undefined
    }
    if (/\s/.test(character)) {
      token = finishWord()
      if (character === "\n" && tokens.length > 0 && !finishSegment()) return undefined
      continue
    }
    if (character === ";" || character === "|") {
      if (character === "|" && command[index + 1] === "|") index += 1
      if (!finishSegment()) return undefined
      continue
    }
    if (character === "&") {
      if (command[index + 1] !== "&") return undefined
      index += 1
      if (!finishSegment()) return undefined
      continue
    }
    if (braces > 0 && (character === "," || (character === "." && command[index + 1] === ".")))
      expansion = true
    if (character === "*" || character === "?" || character === "[") tokenGlob = true
    token += character
    afterOperator = false
  }

  if (quote !== undefined || (!loose && (escaped || afterOperator))) return undefined
  token = finishWord()
  if (tokens.length > 0 && !finishSegment()) return undefined
  return segments.length === 0 ? undefined : segments
}

const resolveExecutable = async (
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const candidates = executable.includes("/")
    ? [isAbsolute(executable) ? executable : resolve(cwd, executable)]
    : (environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) =>
          isAbsolute(entry) ? join(entry, executable) : resolve(cwd, entry, executable)
        )
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {}
  }
  return undefined
}

const suggestedRule = async (
  tokens: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<CommandPolicyRule | undefined> => {
  const executable = tokens[0]
  if (executable === undefined) return undefined
  const executablePath = await resolveExecutable(executable, cwd, environment)
  if (executablePath === undefined) return undefined
  const name = basename(executablePath).toLowerCase()
  if (NEVER_REUSABLE.has(name)) return undefined
  const depth = SUBCOMMAND_DEPTH[name] ?? 0
  const argumentPrefix: string[] = []
  for (const part of tokens.slice(1, depth + 1)) {
    if (part.startsWith("-")) return undefined
    if (!SUBCOMMAND_WORD.test(part)) break
    argumentPrefix.push(part)
  }
  if (depth > 0 && argumentPrefix.length === 0) return undefined
  return {
    executable_path: executablePath,
    argument_prefix: argumentPrefix,
    display_prefix: commandDisplayPrefix(executablePath, argumentPrefix)
  }
}

const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/

const uniqueRules = (rules: ReadonlyArray<CommandPolicyRule>): ReadonlyArray<CommandPolicyRule> => {
  const seen = new Set<string>()
  return rules.filter((rule) => {
    const key = JSON.stringify([rule.executable_path, rule.argument_prefix])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const unallowed = (
  decisions: ReadonlyArray<RuleDecision | undefined>
): RuleDecision | undefined => {
  if (decisions.includes("never")) return "never"
  return decisions.includes("ask") ? "ask" : undefined
}

export const planHostCommandGrant = async (input: {
  readonly command: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly rule: (segment: {
    readonly executable: string
    readonly arguments: ReadonlyArray<string>
  }) => RuleDecision | undefined
}): Promise<HostCommandGrantPlan> => {
  const segments = parseCommandSegments(input.command, { environment: input.environment })
  if (segments === undefined) return { rule: undefined, displayPrefixes: [] }
  const resolved = await Promise.all(
    segments.map(async (tokens) => {
      const candidate = await suggestedRule(tokens, input.cwd, input.environment)
      return candidate === undefined
        ? undefined
        : {
            candidate,
            rule: input.rule({
              executable: candidate.executable_path,
              arguments: tokens.slice(1)
            })
          }
    })
  )
  if (resolved.some((segment) => segment === undefined)) {
    return { rule: undefined, displayPrefixes: [] }
  }
  const decided = resolved.filter((segment) => segment !== undefined)
  const rules = uniqueRules(decided.map((segment) => segment.candidate))
  const decisions = decided.map((segment) => segment.rule)
  if (decisions.every((decision) => decision === "allow"))
    return { rule: "allow", displayPrefixes: rules.map((rule) => rule.display_prefix) }
  const unmatched = uniqueRules(
    decided.flatMap((segment) => (segment.rule === undefined ? [segment.candidate] : []))
  )
  return {
    rule: unallowed(decisions),
    displayPrefixes: unmatched.map((candidate) => candidate.display_prefix),
    ...(unmatched.length === 0 ? {} : { offer: { rules: unmatched } })
  }
}
