import { autoClose, split, tokenize, type ParseResult } from "@openuidev/lang-core"
import { answerBlockFits } from "./fence.js"
import { parseUnguarded } from "./library.js"

const MAX_EXPANDED_TOKENS = 40_000

// lang-core's token kinds are a `const enum` its types do not export as values.
const IDENT = 16
const STATE_VAR = 18
const MINUS = 21
const NUM = 15
const COLON = 8
const LITERAL_TOKENS: ReadonlySet<number> = new Set([3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, NUM, 0])

export interface Statement {
  readonly id: string
  readonly line: number
  readonly isState: boolean
  /** A `$state` line whose value is not a literal (it names another
   *  statement, calls something or does arithmetic). lang-core 1.x folds such
   *  a value into `stateDeclarations`, so only the tokens still tell. */
  readonly computed: boolean
  readonly idents: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
  readonly size: number
  readonly start: number
  readonly end: number
}

type BlockGuard =
  | { readonly kind: "ok"; readonly statements: ReadonlyArray<Statement> }
  | { readonly kind: "too_large" }
  | { readonly kind: "expands" }
  | { readonly kind: "unreadable" }

export type BlockRead =
  | {
      readonly kind: "parsed"
      readonly parsed: ParseResult
      readonly statements: ReadonlyArray<Statement>
    }
  | Exclude<BlockGuard, { readonly kind: "ok" }>

/** The guards every reader of a block goes through before anything parses it:
 *  the byte caps, then the estimate of how far its references inline. The one
 *  definition of "this block may be read", used by the server (`readBlock`)
 *  and by the desktop, whose renderer parses the body itself. */
export function guardBlock(source: string): BlockGuard {
  if (!answerBlockFits(source)) return { kind: "too_large" }
  const statements = readStatements(source)
  if (statements === undefined) return { kind: "unreadable" }
  if (expandedSize(statements) > MAX_EXPANDED_TOKENS) return { kind: "expands" }
  return { kind: "ok", statements }
}

export function readBlock(source: string): BlockRead {
  const guard = guardBlock(source)
  if (guard.kind !== "ok") return guard
  try {
    return { kind: "parsed", parsed: parseUnguarded(source), statements: guard.statements }
  } catch {
    return { kind: "unreadable" }
  }
}

/** The body of a block that is still being written, cut after its last whole
 *  statement. A statement is whole once a line ends it with every bracket and
 *  string closed, as lang-core's own streaming parser counts them. A half-written
 *  one (`Image("https://ima`, `Callout("wa`) is left out, so nothing draws a
 *  value that is still arriving. */
export function completeStatements(source: string, statements: ReadonlyArray<Statement>): string {
  const last = statements.at(-1)
  if (last === undefined) return ""
  const ended =
    source.indexOf("\n", last.end) >= 0 &&
    !autoClose(source.slice(last.start, last.end)).wasIncomplete
  if (!ended) return source.slice(0, last.start)
  let line = last.end
  for (const text of source.slice(last.end).split("\n")) {
    const trimmed = text.trim()
    if (trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
      return source.slice(0, line)
    }
    line += text.length + 1
  }
  return source
}

/** A block body parsed against the parts, or undefined when it is too big,
 *  expands too far or cannot be read. Dropped parts and bad arguments come
 *  back in `meta.errors`; the rest of the block still parses. */
export function readAnswerBlock(source: string): ParseResult | undefined {
  const read = readBlock(source)
  return read.kind === "parsed" ? read.parsed : undefined
}

function readStatements(source: string): ReadonlyArray<Statement> | undefined {
  try {
    const lines = source.split("\n")
    let cursor = 0
    return split(tokenize(source)).map((raw) => {
      const start = lines.findIndex(
        (text, index) => index >= cursor && startsStatement(text, raw.id)
      )
      if (start >= 0) cursor = start + 1
      const values = (kind: number) =>
        raw.tokens.flatMap((token) =>
          token.t === kind && typeof token.v === "string" ? [token.v] : []
        )
      return {
        id: raw.id,
        computed: raw.id.startsWith("$") && !isLiteralValue(raw.tokens),
        line: start >= 0 ? start + 1 : cursor,
        isState: raw.id.startsWith("$"),
        idents: values(IDENT),
        states: values(STATE_VAR),
        size: raw.tokens.length,
        start: raw.start ?? 0,
        end: raw.end ?? source.length
      }
    })
  } catch {
    return undefined
  }
}

function isLiteralValue(tokens: ReadonlyArray<{ readonly t: number }>): boolean {
  return tokens.every(
    (token, index) =>
      LITERAL_TOKENS.has(token.t) ||
      (token.t === MINUS && tokens[index + 1]?.t === NUM) ||
      (token.t === IDENT && tokens[index + 1]?.t === COLON)
  )
}

function startsStatement(text: string, id: string): boolean {
  const rest = text.trimStart()
  if (!rest.startsWith(id)) return false
  const after = rest.slice(id.length).trimStart()
  return after.startsWith("=") && !after.startsWith("==")
}

function expandedSize(statements: ReadonlyArray<Statement>): number {
  const byId = new Map(statements.map((statement) => [statement.id, statement]))
  const sizes = new Map<string, number>()
  const sizeOf = (statement: Statement): number => {
    const known = sizes.get(statement.id)
    if (known !== undefined) return known
    sizes.set(statement.id, statement.size)
    const total = statement.idents.reduce((sum, name) => {
      const target = byId.get(name)
      return target === undefined ? sum : sum + sizeOf(target)
    }, statement.size)
    sizes.set(statement.id, total)
    return total
  }
  return Math.max(0, ...statements.map(sizeOf))
}
