import {
  isRedirect,
  isSubshellMark,
  SEGMENT_READING,
  SHELL_CHARACTER,
  type SegmentReading,
  type ShellCharacter
} from "./shell-words.js"

const EXACT_REFUSED: ReadonlySet<string> = new Set<ShellCharacter>([
  SHELL_CHARACTER.dollar,
  SHELL_CHARACTER.backtick,
  SHELL_CHARACTER.hash,
  SHELL_CHARACTER.output,
  SHELL_CHARACTER.input,
  SHELL_CHARACTER.open,
  SHELL_CHARACTER.close,
  SHELL_CHARACTER.openBrace,
  SHELL_CHARACTER.closeBrace
])

const EXPANSION_START: ReadonlySet<string> = new Set<ShellCharacter>([
  SHELL_CHARACTER.dollar,
  SHELL_CHARACTER.backtick
])

const GLOB_CHARACTERS: ReadonlySet<string> = new Set<ShellCharacter>([
  SHELL_CHARACTER.star,
  SHELL_CHARACTER.question,
  SHELL_CHARACTER.openBracket
])

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

const closing = (
  command: string,
  start: number,
  open: ShellCharacter,
  close: ShellCharacter
): number => {
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < command.length; index += 1) {
    const character = command[index]
    if (character === SHELL_CHARACTER.backslash && quote !== SHELL_CHARACTER.singleQuote) index += 1
    else if (quote !== undefined) {
      if (character === quote) quote = undefined
    } else if (
      character === SHELL_CHARACTER.singleQuote ||
      character === SHELL_CHARACTER.doubleQuote
    )
      quote = character
    else if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const expansionAt = (command: string, index: number): Expansion | undefined => {
  if (command[index] === SHELL_CHARACTER.backtick) {
    let end = index + 1
    while (end < command.length && command[end] !== SHELL_CHARACTER.backtick)
      end += command[end] === SHELL_CHARACTER.backslash ? 2 : 1
    if (end >= command.length) return undefined
    return { word: "`…`", end, runs: command.slice(index + 1, end) }
  }
  const next = command[index + 1]
  if (next === SHELL_CHARACTER.singleQuote) {
    let end = index + 2
    while (end < command.length && command[end] !== SHELL_CHARACTER.singleQuote)
      end += command[end] === SHELL_CHARACTER.backslash ? 2 : 1
    if (end >= command.length) return undefined
    return { word: command.slice(index + 2, end).replace(/\\(.)/g, "$1"), end, runs: undefined }
  }
  if (next === SHELL_CHARACTER.open) {
    const end = closing(command, index + 1, SHELL_CHARACTER.open, SHELL_CHARACTER.close)
    if (end === -1) return undefined
    const arithmetic = command[index + 2] === SHELL_CHARACTER.open
    return { word: "$(…)", end, runs: arithmetic ? undefined : command.slice(index + 2, end) }
  }
  if (next === SHELL_CHARACTER.openBrace) {
    const end = closing(command, index + 1, SHELL_CHARACTER.openBrace, SHELL_CHARACTER.closeBrace)
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
    reading = SEGMENT_READING.exact,
    environment
  }: {
    readonly reading?: SegmentReading
    readonly environment?: NodeJS.ProcessEnv
  } = {}
): ReadonlyArray<ReadonlyArray<string>> | undefined => {
  const loose = reading === SEGMENT_READING.loose
  const unchanged = (word: string): boolean => {
    const at = word.indexOf("=")
    return environment !== undefined && environment[word.slice(0, at)] === word.slice(at + 1)
  }
  const segments: string[][] = []
  let tokens: string[] = []
  let token = ""
  let quote: typeof SHELL_CHARACTER.singleQuote | typeof SHELL_CHARACTER.doubleQuote | undefined
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
    segments.push([SHELL_CHARACTER.open])
    for (const part of parseCommandSegments(inner, {
      reading,
      ...(environment === undefined ? {} : { environment })
    }) ?? []) {
      const copy = [...part]
      const inner = WORD_SYNTAX.get(part)
      if (inner !== undefined) WORD_SYNTAX.set(copy, inner)
      segments.push(copy)
    }
    segments.push([SHELL_CHARACTER.close])
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
      if (!(loose && character === SHELL_CHARACTER.newline)) token += character
      escaped = false
      afterOperator = false
      continue
    }
    if (quote === SHELL_CHARACTER.singleQuote) {
      if (character === SHELL_CHARACTER.singleQuote) quote = undefined
      else token += character
      continue
    }
    if (quote === SHELL_CHARACTER.doubleQuote) {
      if (character === SHELL_CHARACTER.doubleQuote) quote = undefined
      else if (character === SHELL_CHARACTER.backslash) escaped = true
      else if (EXPANSION_START.has(character)) {
        const end = loose ? expand(index) : undefined
        if (end === undefined) return undefined
        index = end
      } else token += character
      continue
    }
    if (character === SHELL_CHARACTER.backslash) {
      escaped = true
      continue
    }
    if (character === SHELL_CHARACTER.singleQuote) {
      quote = SHELL_CHARACTER.singleQuote
      afterOperator = false
      continue
    }
    if (character === SHELL_CHARACTER.doubleQuote) {
      quote = SHELL_CHARACTER.doubleQuote
      afterOperator = false
      continue
    }
    if (loose) {
      const next = command[index + 1]
      if (EXPANSION_START.has(character)) {
        const end = expand(index)
        if (end === undefined) return undefined
        index = end
        continue
      }
      if (character === SHELL_CHARACTER.hash && token.length === 0) {
        const end = command.indexOf("\n", index)
        if (end === -1) break
        index = end - 1
        continue
      }
      if (isRedirect(character) && next === SHELL_CHARACTER.open) {
        const end = closing(command, index + 1, SHELL_CHARACTER.open, SHELL_CHARACTER.close)
        if (end === -1) return undefined
        token += `${character}(…)`
        nested(command.slice(index + 2, end))
        index = end
        continue
      }
      if (
        character === SHELL_CHARACTER.input &&
        next === SHELL_CHARACTER.input &&
        command[index + 2] !== SHELL_CHARACTER.input
      ) {
        const word = /^<<(-?)\s*(['"]?)([^\s'"<>|&;()]+)\2/.exec(command.slice(index))
        const delimiter = word?.[3]
        if (word === null || delimiter === undefined) return undefined
        token = finishWord()
        tokens.push(SHELL_CHARACTER.input, "")
        hereDocuments.push({
          delimiter,
          tabs: word[1] === SHELL_CHARACTER.dash,
          quoted: word[2] !== "",
          words: tokens,
          at: tokens.length - 1
        })
        index += word[0].length - 1
        continue
      }
      if (
        isRedirect(character) ||
        (character === SHELL_CHARACTER.ampersand && next === SHELL_CHARACTER.output)
      ) {
        if (/^\d+$/.test(token)) {
          token = ""
          tokenGlob = false
        } else token = finishWord()
        while (/[<>|&]/.test(command[index + 1] ?? "")) index += 1
        tokens.push(
          character === SHELL_CHARACTER.input ? SHELL_CHARACTER.input : SHELL_CHARACTER.output
        )
        afterOperator = false
        continue
      }
      if (character === SHELL_CHARACTER.newline && hereDocuments.length > 0) {
        finishSegment()
        for (const document of hereDocuments.splice(0)) {
          const read = hereDocumentBody(command, index, document)
          document.words[document.at] = read.body
          if (!document.quoted) {
            for (let at = 0; at < read.body.length; at += 1) {
              const character = read.body[at] ?? ""
              if (character === SHELL_CHARACTER.backslash) at += 1
              else if (EXPANSION_START.has(character)) {
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
        ((character === SHELL_CHARACTER.openBrace && (next === undefined || /\s/.test(next))) ||
          (character === SHELL_CHARACTER.closeBrace &&
            (next === undefined || /[\s;|&)]/.test(next))))
      if (
        isSubshellMark(character) ||
        group ||
        (character === SHELL_CHARACTER.ampersand && next !== SHELL_CHARACTER.ampersand)
      ) {
        finishSegment()
        if (isSubshellMark(character)) segments.push([character])
        continue
      }
      if (character === SHELL_CHARACTER.openBrace || character === SHELL_CHARACTER.closeBrace) {
        braces = character === SHELL_CHARACTER.openBrace ? braces + 1 : Math.max(0, braces - 1)
        token += character
        continue
      }
    }
    if (EXACT_REFUSED.has(character)) return undefined
    if (/\s/.test(character)) {
      token = finishWord()
      if (character === SHELL_CHARACTER.newline && tokens.length > 0 && !finishSegment())
        return undefined
      continue
    }
    if (character === SHELL_CHARACTER.semicolon || character === SHELL_CHARACTER.pipe) {
      if (character === SHELL_CHARACTER.pipe && command[index + 1] === SHELL_CHARACTER.pipe)
        index += 1
      if (!finishSegment()) return undefined
      continue
    }
    if (character === SHELL_CHARACTER.ampersand) {
      if (command[index + 1] !== SHELL_CHARACTER.ampersand) return undefined
      index += 1
      if (!finishSegment()) return undefined
      continue
    }
    if (
      braces > 0 &&
      (character === SHELL_CHARACTER.comma ||
        (character === SHELL_CHARACTER.dot && command[index + 1] === SHELL_CHARACTER.dot))
    )
      expansion = true
    if (GLOB_CHARACTERS.has(character)) tokenGlob = true
    token += character
    afterOperator = false
  }

  if (quote !== undefined || (!loose && (escaped || afterOperator))) return undefined
  token = finishWord()
  if (tokens.length > 0 && !finishSegment()) return undefined
  return segments.length === 0 ? undefined : segments
}
