import { nounFor } from "@arden-hq/std/count"

const MAX_FORMULA_CHARS = 500
const MAX_DEPTH = 24
const MAX_ROUND_DIGITS = 10

type Compute = (vars: Readonly<Record<string, number>>) => number

interface FunctionDef {
  readonly arity: readonly [min: number, max: number]
  readonly apply: (args: readonly number[]) => number
}

const one = (f: (x: number) => number): FunctionDef => ({
  arity: [1, 1],
  apply: (args) => f(args[0] ?? Number.NaN)
})

const FUNCTIONS: Readonly<Record<string, FunctionDef>> = {
  min: { arity: [1, 16], apply: (args) => Math.min(...args) },
  max: { arity: [1, 16], apply: (args) => Math.max(...args) },
  abs: one(Math.abs),
  round: {
    arity: [1, 2],
    apply: ([x = Number.NaN, digits = 0]) => {
      const scale = 10 ** Math.min(MAX_ROUND_DIGITS, Math.max(0, Math.trunc(digits)))
      return Math.round(x * scale) / scale
    }
  },
  floor: one(Math.floor),
  ceil: one(Math.ceil),
  exp: one(Math.exp),
  ln: one(Math.log),
  log10: one(Math.log10),
  sqrt: one(Math.sqrt),
  pow: { arity: [2, 2], apply: ([x = Number.NaN, y = Number.NaN]) => x ** y }
}

const FORMULA_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS)

export interface Formula {
  readonly source: string
  readonly variables: readonly string[]
  readonly compute: Compute
}

export const FORMULA_VALUE_KIND = { value: "value", invalid: "invalid" } as const

interface FormulaInvalid {
  readonly kind: typeof FORMULA_VALUE_KIND.invalid
  readonly reason: string
}

export const FORMULA_READ_KIND = {
  formula: "formula",
  invalid: FORMULA_VALUE_KIND.invalid
} as const

export type FormulaRead =
  | { readonly kind: typeof FORMULA_READ_KIND.formula; readonly formula: Formula }
  | FormulaInvalid

export type FormulaValue =
  | { readonly kind: typeof FORMULA_VALUE_KIND.value; readonly value: number }
  | FormulaInvalid

const TOKEN_KIND = { number: "number", name: "name", symbol: "symbol", end: "end" } as const

const FORMULA_SYMBOL = {
  plus: "+",
  minus: "-",
  times: "*",
  divide: "/",
  power: "^",
  open: "(",
  close: ")",
  comma: ","
} as const
type FormulaSymbol = (typeof FORMULA_SYMBOL)[keyof typeof FORMULA_SYMBOL]
const FORMULA_SYMBOLS: ReadonlySet<string> = new Set<FormulaSymbol>(Object.values(FORMULA_SYMBOL))
const isFormulaSymbol = (char: string): char is FormulaSymbol => FORMULA_SYMBOLS.has(char)

type Token =
  | { readonly kind: typeof TOKEN_KIND.number; readonly value: number; readonly at: number }
  | { readonly kind: typeof TOKEN_KIND.name; readonly name: string; readonly at: number }
  | { readonly kind: typeof TOKEN_KIND.symbol; readonly symbol: FormulaSymbol; readonly at: number }
  | { readonly kind: typeof TOKEN_KIND.end; readonly at: number }

class FormulaProblem {
  constructor(readonly reason: string) {}
}

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < source.length) {
    const rest = source.slice(at)
    const space = /^\s+/.exec(rest)
    if (space) {
      at += space[0].length
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) {
      tokens.push({ kind: TOKEN_KIND.number, value: Number(number[0]), at })
      at += number[0].length
      continue
    }
    const name = NAME.exec(rest)
    if (name) {
      tokens.push({ kind: TOKEN_KIND.name, name: name[0], at })
      at += name[0].length
      continue
    }
    const char = rest.charAt(0)
    if (!isFormulaSymbol(char))
      throw new FormulaProblem(
        `\`${char}\` at character ${at + 1} is not allowed; use numbers, variables, + - * / ^, parentheses and ${FORMULA_FUNCTIONS.join(", ")}`
      )
    tokens.push({ kind: TOKEN_KIND.symbol, symbol: char, at })
    at += 1
  }
  tokens.push({ kind: TOKEN_KIND.end, at })
  return tokens
}

const describe = (token: Token): string => {
  switch (token.kind) {
    case TOKEN_KIND.number:
      return `\`${token.value}\` at character ${token.at + 1}`
    case TOKEN_KIND.name:
      return `\`${token.name}\` at character ${token.at + 1}`
    case TOKEN_KIND.symbol:
      return `\`${token.symbol}\` at character ${token.at + 1}`
    case TOKEN_KIND.end:
      return "the end"
  }
}

const READ = new Map<string, FormulaRead>()
const READ_CACHE_SIZE = 256

export function readFormula(source: string): FormulaRead {
  const known = READ.get(source)
  if (known !== undefined) return known
  const read = parseFormula(source)
  if (READ.size >= READ_CACHE_SIZE) READ.clear()
  READ.set(source, read)
  return read
}

function parseFormula(source: string): FormulaRead {
  if (source.trim().length === 0)
    return { kind: FORMULA_READ_KIND.invalid, reason: "the formula is empty" }
  if (source.length > MAX_FORMULA_CHARS)
    return {
      kind: FORMULA_READ_KIND.invalid,
      reason: `the formula is over ${MAX_FORMULA_CHARS} characters; split it into simpler ones`
    }
  try {
    const tokens = tokenize(source)
    const variables: string[] = []
    let index = 0
    let depth = 0
    const peek = (): Token => tokens[index] ?? { kind: TOKEN_KIND.end, at: source.length }
    const take = (): Token => {
      const token = peek()
      index += 1
      return token
    }
    const isSymbol = (token: Token, symbol: FormulaSymbol) =>
      token.kind === TOKEN_KIND.symbol && token.symbol === symbol
    const expect = (symbol: FormulaSymbol) => {
      const token = take()
      if (!isSymbol(token, symbol))
        throw new FormulaProblem(`expected \`${symbol}\` but found ${describe(token)}`)
    }
    const nested = <T>(read: () => T): T => {
      depth += 1
      if (depth > MAX_DEPTH)
        throw new FormulaProblem(`the formula nests deeper than ${MAX_DEPTH} levels`)
      const result = read()
      depth -= 1
      return result
    }

    const sum = (): Compute => {
      let node = product()
      for (;;) {
        const token = peek()
        if (!isSymbol(token, FORMULA_SYMBOL.plus) && !isSymbol(token, FORMULA_SYMBOL.minus))
          return node
        take()
        const left = node
        const right = product()
        node = isSymbol(token, FORMULA_SYMBOL.plus)
          ? (v) => left(v) + right(v)
          : (v) => left(v) - right(v)
      }
    }
    const product = (): Compute => {
      let node = signed()
      for (;;) {
        const token = peek()
        if (!isSymbol(token, FORMULA_SYMBOL.times) && !isSymbol(token, FORMULA_SYMBOL.divide))
          return node
        take()
        if (isSymbol(token, FORMULA_SYMBOL.times) && isSymbol(peek(), FORMULA_SYMBOL.times))
          throw new FormulaProblem(`write a power with ^, not ** (character ${token.at + 1})`)
        const left = node
        const right = signed()
        node = isSymbol(token, FORMULA_SYMBOL.times)
          ? (v) => left(v) * right(v)
          : (v) => left(v) / right(v)
      }
    }
    const signed = (): Compute => {
      const token = peek()
      if (isSymbol(token, FORMULA_SYMBOL.minus)) {
        take()
        const inner = nested(signed)
        return (v) => -inner(v)
      }
      if (isSymbol(token, FORMULA_SYMBOL.plus)) {
        take()
        return nested(signed)
      }
      return power()
    }
    const power = (): Compute => {
      const base = primary()
      if (!isSymbol(peek(), FORMULA_SYMBOL.power)) return base
      take()
      const exponent = nested(signed)
      return (v) => base(v) ** exponent(v)
    }
    const primary = (): Compute => {
      const token = take()
      switch (token.kind) {
        case TOKEN_KIND.number: {
          const value = token.value
          return () => value
        }
        case TOKEN_KIND.name:
          return isSymbol(peek(), FORMULA_SYMBOL.open)
            ? call(token.name, token.at)
            : variable(token.name)
        case TOKEN_KIND.symbol:
          if (token.symbol === FORMULA_SYMBOL.open) {
            const inner = nested(sum)
            expect(FORMULA_SYMBOL.close)
            return inner
          }
          throw new FormulaProblem(`unexpected ${describe(token)}`)
        case TOKEN_KIND.end:
          throw new FormulaProblem("the formula ends too early")
      }
    }
    const variable = (name: string): Compute => {
      if (!variables.includes(name)) variables.push(name)
      return (v) => v[name] ?? Number.NaN
    }
    const call = (name: string, at: number): Compute => {
      const def = FUNCTIONS[name]
      if (def === undefined)
        throw new FormulaProblem(
          `\`${name}\` at character ${at + 1} is not a function; use one of ${FORMULA_FUNCTIONS.join(", ")}`
        )
      expect(FORMULA_SYMBOL.open)
      const args = nested(() => {
        const read: Compute[] = []
        if (isSymbol(peek(), FORMULA_SYMBOL.close)) return read
        read.push(sum())
        while (isSymbol(peek(), FORMULA_SYMBOL.comma)) {
          take()
          read.push(sum())
        }
        return read
      })
      expect(FORMULA_SYMBOL.close)
      const [min, max] = def.arity
      if (args.length < min || args.length > max)
        throw new FormulaProblem(
          `\`${name}\` takes ${min === max ? min : `${min} to ${max}`} ${nounFor(max, "argument")}, not ${args.length}`
        )
      return (v) => def.apply(args.map((arg) => arg(v)))
    }

    const compute = sum()
    const rest = peek()
    if (rest.kind !== TOKEN_KIND.end) throw new FormulaProblem(`unexpected ${describe(rest)}`)
    return { kind: FORMULA_READ_KIND.formula, formula: { source, variables, compute } }
  } catch (error) {
    if (error instanceof FormulaProblem)
      return { kind: FORMULA_READ_KIND.invalid, reason: error.reason }
    return {
      kind: FORMULA_READ_KIND.invalid,
      reason: "the formula could not be read; write it more simply"
    }
  }
}

export const missingVariables = (formula: Formula, known: Iterable<string>): string[] => {
  const names = new Set(known)
  return formula.variables.filter((name) => !names.has(name))
}

export function evaluateFormula(
  formula: Formula,
  vars: Readonly<Record<string, unknown>>
): FormulaValue {
  const values: Record<string, number> = {}
  for (const name of formula.variables) {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined
    if (value === undefined)
      return { kind: FORMULA_VALUE_KIND.invalid, reason: `\`${name}\` is not in vars` }
    if (typeof value !== "number" || !Number.isFinite(value))
      return { kind: FORMULA_VALUE_KIND.invalid, reason: `\`${name}\` is not a number` }
    values[name] = value
  }
  const value = formula.compute(values)
  return Number.isFinite(value)
    ? { kind: FORMULA_VALUE_KIND.value, value }
    : {
        kind: FORMULA_VALUE_KIND.invalid,
        reason: "the result is not a finite number for these values"
      }
}
