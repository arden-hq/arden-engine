import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { narrowerApprovalMode } from "@arden-hq/protocol/permissions"
import type { ShellAccess } from "./shell-policy.js"

const TERMINAL_CHAR = {
  newline: "\n",
  carriage_return: "\r",
  interrupt: "\u0003",
  delete: "\u007f",
  backspace: "\b",
  erase_line: "\u0015",
  erase_word: "\u0017",
  escape: "\u001b",
  tab: "\t",
  csi: "[",
  ss3: "O",
  ignored_escape: ":",
  forward_delete_csi: "3~"
} as const

type TerminalChar = (typeof TERMINAL_CHAR)[keyof typeof TERMINAL_CHAR]

export const INTERRUPT: TerminalChar = TERMINAL_CHAR.interrupt

const MAX_LINE = 4_096

const MAX_SHUFFLED_WORDS = 6

const TYPED_LINE_STATE = { known: "known", moved: "moved", unreadable: "unreadable" } as const

type TypedLineState = (typeof TYPED_LINE_STATE)[keyof typeof TYPED_LINE_STATE]

export interface TypedLine {
  readonly text: string
  readonly raw: string
  readonly state: TypedLineState
  readonly escaped: boolean
}

export const EMPTY_LINE: TypedLine = {
  text: "",
  raw: "",
  state: TYPED_LINE_STATE.known,
  escaped: false
}

export const TYPED_INPUT = { refused: "refused", typed: "typed" } as const

export type TypedInput =
  | { readonly kind: typeof TYPED_INPUT.refused }
  | {
      readonly kind: typeof TYPED_INPUT.typed
      readonly sent: ReadonlyArray<TypedLine>
      readonly pending: TypedLine
    }

export const typeInto = (pending: TypedLine, chars: string): TypedInput => {
  if (chars.includes("\0")) return { kind: TYPED_INPUT.refused }
  const input = pending.escaped ? `${TERMINAL_CHAR.escape}${chars}` : chars
  const sent: TypedLine[] = []
  let line: TypedLine = { ...pending, escaped: false }
  let at = 0
  while (at < input.length) {
    const key = readKey(input, at)
    at = key.end
    line = afterKey(line, key, sent)
    if (
      key.kind === KEY_KIND.dropped &&
      key.end === input.length &&
      input.endsWith(TERMINAL_CHAR.escape)
    )
      line = { ...line, escaped: true }
  }
  return { kind: TYPED_INPUT.typed, sent, pending: line }
}

const afterKey = (line: TypedLine, key: Key, sent: TypedLine[]): TypedLine => {
  const moved = line.state !== TYPED_LINE_STATE.known
  const erased = moved ? TYPED_LINE_STATE.unreadable : TYPED_LINE_STATE.known
  switch (key.kind) {
    case KEY_KIND.char:
      return edited(line, line.text + key.text, key.text, line.state)
    case KEY_KIND.enter:
      sent.push(line)
      return EMPTY_LINE
    case KEY_KIND.interrupt:
      return EMPTY_LINE
    case KEY_KIND.erase_char:
      return edited(line, line.text.slice(0, -1), TERMINAL_CHAR.delete, erased)
    case KEY_KIND.erase_line:
      return moved
        ? edited(line, "", TERMINAL_CHAR.erase_line, TYPED_LINE_STATE.unreadable)
        : EMPTY_LINE
    case KEY_KIND.erase_word:
      return edited(line, line.text.replace(/\S*\s*$/u, ""), TERMINAL_CHAR.erase_word, erased)
    case KEY_KIND.erase_forward:
      return moved
        ? edited(line, line.text, TERMINAL_CHAR.escape, TYPED_LINE_STATE.unreadable)
        : line
    case KEY_KIND.dropped:
      return line
    case KEY_KIND.move:
      return edited(line, line.text, TERMINAL_CHAR.escape, TYPED_LINE_STATE.moved)
    case KEY_KIND.unreadable:
      return edited(
        line,
        line.text + key.text,
        key.text === "" ? TERMINAL_CHAR.escape : key.text,
        TYPED_LINE_STATE.unreadable
      )
  }
}

export const TYPED_COMMANDS = { none: "none", lines: "lines" } as const

export type TypedCommands =
  | { readonly kind: typeof TYPED_COMMANDS.none }
  | {
      readonly kind: typeof TYPED_COMMANDS.lines
      readonly judged: string | undefined
      readonly shown: string
      readonly unknown: boolean
      readonly unreadable: boolean
    }

export const typedCommands = (sent: ReadonlyArray<TypedLine>): TypedCommands => {
  const counted = sent.filter(
    (line) => line.state !== TYPED_LINE_STATE.known || line.text.trim() !== ""
  )
  if (counted.length === 0) return { kind: TYPED_COMMANDS.none }
  const readings = [...new Set(counted.flatMap(lineReadings))].filter(
    (reading) => reading.trim() !== ""
  )
  return {
    kind: TYPED_COMMANDS.lines,
    judged: readings.length === 0 ? undefined : readings.join("\n"),
    shown: counted.map((line) => line.text).join("\n"),
    unknown: counted.some((line) => line.state !== TYPED_LINE_STATE.known),
    unreadable: counted.some(
      (line) =>
        line.state === TYPED_LINE_STATE.unreadable ||
        (line.state === TYPED_LINE_STATE.moved &&
          (wordsOf(line).length > MAX_SHUFFLED_WORDS ||
            lineReadings(line).every((reading) => reading.trim() === "")))
    )
  }
}

const lineReadings = (line: TypedLine): ReadonlyArray<string> => {
  if (line.state === TYPED_LINE_STATE.known) return [line.text]
  const words = wordsOf(line)
  return [
    line.text,
    line.raw.replace(CONTROL_ALL, ""),
    ...line.raw.split(CONTROL),
    ...(words.length > MAX_SHUFFLED_WORDS ? [] : orders(words).map((order) => order.join(" ")))
  ]
}

const wordsOf = (line: TypedLine): ReadonlyArray<string> =>
  line.raw
    .split(CONTROL)
    .flatMap((piece) => piece.split(/\s+/u))
    .filter((word) => word !== "")

const orders = (words: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  words.length <= 1
    ? [words]
    : words.flatMap((word, index) =>
        orders([...words.slice(0, index), ...words.slice(index + 1)]).map((rest) => [word, ...rest])
      )

const JUDGED_BY_ACCESS: Readonly<Record<ShellAccess, boolean | undefined>> = {
  sandbox: false,
  network: undefined,
  host: true
}

export const typedInputJudged = (terminal: {
  readonly access: ShellAccess
  readonly launchMode: ChatApprovalMode
  readonly mode: ChatApprovalMode
}): boolean =>
  JUDGED_BY_ACCESS[terminal.access] ??
  narrowerApprovalMode(terminal.mode, terminal.launchMode) !== terminal.launchMode

export const typedInputRefused = (input: {
  readonly commands: TypedCommands
  readonly judged: boolean
  readonly card: boolean
}): boolean =>
  input.commands.kind === TYPED_COMMANDS.lines &&
  input.commands.unreadable &&
  input.judged &&
  !input.card

const CONTROL = /[\u0000-\u001f\u007f]+/u
const CONTROL_ALL = /[\u0000-\u001f\u007f]+/gu

const KEY_KIND = {
  char: "char",
  unreadable: "unreadable",
  enter: "enter",
  interrupt: "interrupt",
  erase_char: "erase_char",
  erase_line: "erase_line",
  erase_word: "erase_word",
  erase_forward: "erase_forward",
  dropped: "dropped",
  move: "move"
} as const

type KeyKind = (typeof KEY_KIND)[keyof typeof KEY_KIND]

type TextKeyKind = typeof KEY_KIND.char | typeof KEY_KIND.unreadable

type Key =
  | { readonly kind: TextKeyKind; readonly text: string; readonly end: number }
  | { readonly kind: Exclude<KeyKind, TextKeyKind>; readonly end: number }

const DROPPED_CSI = new Set(["200~", "201~", "I", "O"])

const MOVE_KEYS = new Set(["\u0001", "\u0002", "\u0005", "\u0006", "\u000e", "\u0010"])
const MOVE_CSI = new Set(["A", "B", "C", "D", "F", "H", "1~", "4~", "7~", "8~"])
const MOVE_SS3 = new Set(["A", "B", "C", "D", "F", "H"])

const CONTROL_KEYS: ReadonlyMap<string, Exclude<KeyKind, TextKeyKind>> = new Map([
  [TERMINAL_CHAR.newline, KEY_KIND.enter],
  [TERMINAL_CHAR.carriage_return, KEY_KIND.enter],
  [TERMINAL_CHAR.interrupt, KEY_KIND.interrupt],
  [TERMINAL_CHAR.delete, KEY_KIND.erase_char],
  [TERMINAL_CHAR.backspace, KEY_KIND.erase_char],
  [TERMINAL_CHAR.erase_line, KEY_KIND.erase_line],
  [TERMINAL_CHAR.erase_word, KEY_KIND.erase_word]
])

const ESCAPED_KEYS: ReadonlyMap<string, Exclude<KeyKind, TextKeyKind>> = new Map([
  ["b", KEY_KIND.move],
  ["f", KEY_KIND.move],
  ["d", KEY_KIND.erase_forward],
  [TERMINAL_CHAR.delete, KEY_KIND.erase_word]
])

const readKey = (chars: string, at: number): Key => {
  const char = chars.charAt(at)
  const end = at + 1
  const control = CONTROL_KEYS.get(char)
  if (control !== undefined) return { kind: control, end }
  if (char === TERMINAL_CHAR.escape) return escapeKey(chars, at)
  if (MOVE_KEYS.has(char)) return { kind: KEY_KIND.move, end }
  if (char >= " ") return { kind: KEY_KIND.char, text: char, end }
  return { kind: KEY_KIND.unreadable, text: char === TERMINAL_CHAR.tab ? char : "", end }
}

const escapeKey = (chars: string, at: number): Key => {
  const next = chars.charAt(at + 1)
  if (next === "" || next === TERMINAL_CHAR.ignored_escape)
    return { kind: KEY_KIND.dropped, end: at + 1 }
  if (next === TERMINAL_CHAR.csi) {
    const csi = /^[0-?]*[ -/]*[@-~]/u.exec(chars.slice(at + 2))
    if (csi === null) return { kind: KEY_KIND.unreadable, text: "", end: chars.length }
    const end = at + 2 + csi[0].length
    if (DROPPED_CSI.has(csi[0])) return { kind: KEY_KIND.dropped, end }
    if (csi[0] === TERMINAL_CHAR.forward_delete_csi) return { kind: KEY_KIND.erase_forward, end }
    return MOVE_CSI.has(csi[0])
      ? { kind: KEY_KIND.move, end }
      : { kind: KEY_KIND.unreadable, text: "", end }
  }
  if (next === TERMINAL_CHAR.ss3) {
    const end = Math.min(at + 3, chars.length)
    return MOVE_SS3.has(chars.charAt(at + 2))
      ? { kind: KEY_KIND.move, end }
      : { kind: KEY_KIND.unreadable, text: "", end }
  }
  const escaped = ESCAPED_KEYS.get(next)
  if (escaped !== undefined) return { kind: escaped, end: at + 2 }
  const control = next < " " && next !== TERMINAL_CHAR.escape
  return { kind: KEY_KIND.unreadable, text: "", end: control ? at + 1 : at + 2 }
}

const edited = (line: TypedLine, text: string, typed: string, state: TypedLineState): TypedLine => {
  const raw = line.raw + typed
  const worst = worse(line.state, state)
  return {
    escaped: false,
    text: text.slice(-MAX_LINE),
    raw: raw.slice(-MAX_LINE),
    state:
      text.length > MAX_LINE || raw.length > MAX_LINE ? worse(worst, TYPED_LINE_STATE.moved) : worst
  }
}

const RANK: Record<TypedLineState, number> = { known: 0, moved: 1, unreadable: 2 }

const worse = (left: TypedLineState, right: TypedLineState): TypedLineState =>
  RANK[left] >= RANK[right] ? left : right
