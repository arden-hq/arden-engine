import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { narrowerApprovalMode } from "@arden-hq/protocol/permissions"
import type { ShellAccess } from "./shell-policy.js"

export const INTERRUPT = "\u0003"

const MAX_LINE = 4_096

const MAX_SHUFFLED_WORDS = 6

export interface TypedLine {
  readonly text: string
  readonly raw: string
  readonly state: "known" | "moved" | "unreadable"
  readonly escaped: boolean
}

export const EMPTY_LINE: TypedLine = { text: "", raw: "", state: "known", escaped: false }

export type TypedInput =
  | { readonly kind: "refused" }
  | {
      readonly kind: "typed"
      readonly sent: ReadonlyArray<TypedLine>
      readonly pending: TypedLine
    }

export const typeInto = (pending: TypedLine, chars: string): TypedInput => {
  if (chars.includes("\0")) return { kind: "refused" }
  const input = pending.escaped ? `\u001b${chars}` : chars
  const sent: TypedLine[] = []
  let line: TypedLine = { ...pending, escaped: false }
  let at = 0
  while (at < input.length) {
    const key = readKey(input, at)
    at = key.end
    line = afterKey(line, key, sent)
    if (key.kind === "dropped" && key.end === input.length && input.endsWith("\u001b"))
      line = { ...line, escaped: true }
  }
  return { kind: "typed", sent, pending: line }
}

const afterKey = (line: TypedLine, key: Key, sent: TypedLine[]): TypedLine => {
  const moved = line.state !== "known"
  switch (key.kind) {
    case "char":
      return edited(line, line.text + key.text, key.text, line.state)
    case "enter":
      sent.push(line)
      return EMPTY_LINE
    case "interrupt":
      return EMPTY_LINE
    case "erase_char":
      return edited(line, line.text.slice(0, -1), "\u007f", moved ? "unreadable" : "known")
    case "erase_line":
      return moved ? edited(line, "", "\u0015", "unreadable") : EMPTY_LINE
    case "erase_word":
      return edited(
        line,
        line.text.replace(/\S*\s*$/u, ""),
        "\u0017",
        moved ? "unreadable" : "known"
      )
    case "erase_forward":
      return moved ? edited(line, line.text, "\u001b", "unreadable") : line
    case "dropped":
      return line
    case "move":
      return edited(line, line.text, "\u001b", "moved")
    case "unreadable":
      return edited(line, line.text + key.text, key.text === "" ? "\u001b" : key.text, "unreadable")
  }
}

export type TypedCommands =
  | { readonly kind: "none" }
  | {
      readonly kind: "lines"
      readonly judged: string | undefined
      readonly shown: string
      readonly unknown: boolean
      readonly unreadable: boolean
    }

export const typedCommands = (sent: ReadonlyArray<TypedLine>): TypedCommands => {
  const counted = sent.filter((line) => line.state !== "known" || line.text.trim() !== "")
  if (counted.length === 0) return { kind: "none" }
  const readings = [...new Set(counted.flatMap(lineReadings))].filter(
    (reading) => reading.trim() !== ""
  )
  return {
    kind: "lines",
    judged: readings.length === 0 ? undefined : readings.join("\n"),
    shown: counted.map((line) => line.text).join("\n"),
    unknown: counted.some((line) => line.state !== "known"),
    unreadable: counted.some(
      (line) =>
        line.state === "unreadable" ||
        (line.state === "moved" &&
          (wordsOf(line).length > MAX_SHUFFLED_WORDS ||
            lineReadings(line).every((reading) => reading.trim() === "")))
    )
  }
}

const lineReadings = (line: TypedLine): ReadonlyArray<string> => {
  if (line.state === "known") return [line.text]
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

export const typedInputJudged = (terminal: {
  readonly access: ShellAccess
  readonly launchMode: ChatApprovalMode
  readonly mode: ChatApprovalMode
}): boolean => {
  if (terminal.access === "sandbox") return false
  return (
    terminal.access === "host" ||
    narrowerApprovalMode(terminal.mode, terminal.launchMode) !== terminal.launchMode
  )
}

export const typedInputRefused = (input: {
  readonly commands: TypedCommands
  readonly judged: boolean
  readonly card: boolean
}): boolean =>
  input.commands.kind === "lines" && input.commands.unreadable && input.judged && !input.card

const CONTROL = /[\u0000-\u001f\u007f]+/u
const CONTROL_ALL = /[\u0000-\u001f\u007f]+/gu

type Key =
  | { readonly kind: "char" | "unreadable"; readonly text: string; readonly end: number }
  | {
      readonly kind:
        | "enter"
        | "interrupt"
        | "erase_char"
        | "erase_line"
        | "erase_word"
        | "erase_forward"
        | "dropped"
        | "move"
      readonly end: number
    }

const DROPPED_CSI = new Set(["200~", "201~", "I", "O"])

const MOVE_KEYS = new Set(["\u0001", "\u0002", "\u0005", "\u0006", "\u000e", "\u0010"])
const MOVE_CSI = new Set(["A", "B", "C", "D", "F", "H", "1~", "4~", "7~", "8~"])
const MOVE_SS3 = new Set(["A", "B", "C", "D", "F", "H"])

const readKey = (chars: string, at: number): Key => {
  const char = chars.charAt(at)
  const end = at + 1
  switch (char) {
    case "\n":
    case "\r":
      return { kind: "enter", end }
    case INTERRUPT:
      return { kind: "interrupt", end }
    case "\u007f":
    case "\b":
      return { kind: "erase_char", end }
    case "\u0015":
      return { kind: "erase_line", end }
    case "\u0017":
      return { kind: "erase_word", end }
    case "\u001b":
      return escapeKey(chars, at)
  }
  if (MOVE_KEYS.has(char)) return { kind: "move", end }
  if (char >= " ") return { kind: "char", text: char, end }
  return { kind: "unreadable", text: char === "\t" ? char : "", end }
}

const escapeKey = (chars: string, at: number): Key => {
  const next = chars.charAt(at + 1)
  if (next === "" || next === ":") return { kind: "dropped", end: at + 1 }
  if (next === "[") {
    const csi = /^[0-?]*[ -/]*[@-~]/u.exec(chars.slice(at + 2))
    if (csi === null) return { kind: "unreadable", text: "", end: chars.length }
    const end = at + 2 + csi[0].length
    if (DROPPED_CSI.has(csi[0])) return { kind: "dropped", end }
    if (csi[0] === "3~") return { kind: "erase_forward", end }
    return MOVE_CSI.has(csi[0]) ? { kind: "move", end } : { kind: "unreadable", text: "", end }
  }
  if (next === "O") {
    const end = Math.min(at + 3, chars.length)
    return MOVE_SS3.has(chars.charAt(at + 2))
      ? { kind: "move", end }
      : { kind: "unreadable", text: "", end }
  }
  switch (next) {
    case "b":
    case "f":
      return { kind: "move", end: at + 2 }
    case "d":
      return { kind: "erase_forward", end: at + 2 }
    case "\u007f":
      return { kind: "erase_word", end: at + 2 }
  }
  const control = next < " " && next !== "\u001b"
  return { kind: "unreadable", text: "", end: control ? at + 1 : at + 2 }
}

const edited = (
  line: TypedLine,
  text: string,
  typed: string,
  state: TypedLine["state"]
): TypedLine => {
  const raw = line.raw + typed
  const worst = worse(line.state, state)
  return {
    escaped: false,
    text: text.slice(-MAX_LINE),
    raw: raw.slice(-MAX_LINE),
    state: text.length > MAX_LINE || raw.length > MAX_LINE ? worse(worst, "moved") : worst
  }
}

const RANK: Record<TypedLine["state"], number> = { known: 0, moved: 1, unreadable: 2 }

const worse = (left: TypedLine["state"], right: TypedLine["state"]): TypedLine["state"] =>
  RANK[left] >= RANK[right] ? left : right
