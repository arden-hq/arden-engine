export interface CitedChat {
  readonly publicRef: string
  readonly title: string
  readonly sentAt: ReadonlyMap<number, Date>
}

export interface ChatPointer {
  readonly publicRef: string
  readonly sequences: ReadonlyArray<number>
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" })

const sameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate()

export const evidenceDateLabel = (dates: ReadonlyArray<Date>, now: Date): string | undefined => {
  const sorted = [...dates].sort((left, right) => left.getTime() - right.getTime())
  const first = sorted[0]
  const last = sorted.at(-1)
  if (first === undefined || last === undefined) return undefined
  const year = last.getFullYear() === now.getFullYear() ? "" : `, ${last.getFullYear()}`
  if (sameDay(first, last)) return `${MONTH_DAY.format(first)}${year}`
  if (first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth()) {
    return `${MONTH.format(first)} ${first.getDate()}–${last.getDate()}${year}`
  }
  const firstYear = first.getFullYear() === last.getFullYear() ? "" : `, ${first.getFullYear()}`
  return `${MONTH_DAY.format(first)}${firstYear} – ${MONTH_DAY.format(last)}${year}`
}

const linkLabel = (title: string): string => {
  const trimmed = title.replace(/\s+/gu, " ").trim()
  return (trimmed.length > 0 ? trimmed : "Untitled chat").replace(/\[/gu, "(").replace(/\]/gu, ")")
}

export const chatCitation = (
  chat: { readonly publicRef: string; readonly title: string },
  date: string | undefined
): string => {
  const link = `[${linkLabel(chat.title)}](arden:session/${encodeURIComponent(chat.publicRef)})`
  return date === undefined ? link : `${link}, ${date}`
}

const REF = String.raw`[a-z0-9][a-z0-9-]*~[a-z0-9]{5,8}`
const SEQUENCES = String.raw`(?:[ ,]*#\d+(?:\s*[–-]\s*#?\d+)?)*`
const TRAILING = String.raw`(?:(?:,\s*(?:and\s+)?|\s+and\s+)\x60#\d+\x60)*`
const POINTER = new RegExp(
  String.raw`(?:(?<!user )\bchat,? )?\x60(${REF})(${SEQUENCES})\x60(${TRAILING})`,
  "gu"
)

const sequencesIn = (text: string): ReadonlyArray<number> =>
  [...text.matchAll(/#?(\d+)(?:\s*[–-]\s*#?(\d+))?/gu)].flatMap((match) =>
    [match[1], match[2]].flatMap((value) => (value === undefined ? [] : [Number(value)]))
  )

export const chatPointers = (body: string): ReadonlyArray<ChatPointer> =>
  [...body.matchAll(POINTER)].flatMap((match) => {
    const publicRef = match[1]
    return publicRef === undefined
      ? []
      : [{ publicRef, sequences: sequencesIn(`${match[2] ?? ""} ${match[3] ?? ""}`) }]
  })

const MISSING_DATE: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ \t]*\*\*Evidence dates? unavailable\.\*\*/gu, ""],
  [/\*\*Evidence dates? unavailable( for [^:*]+)?:\*\*/gu, "**Evidence$1:**"],
  [/ — evidence dates? unavailable:\*\*/giu, ":**"],
  [
    /;\s*(?:original\s+)?(?:evidence\s+)?dates?\s+(?:unavailable|not supplied)(?:\s+for\s+[^;.)]+)?/giu,
    ""
  ],
  [/\s*\((?:original\s+)?(?:evidence\s+)?dates?\s+(?:unavailable|not supplied)\)/giu, ""],
  [/\((?:original\s+)?(?:evidence\s+)?dates?\s+(?:unavailable|not supplied);\s*/giu, "("],
  [/,\s*date unavailable,/giu, ","],
  [/preceding proposal: assistant #\d+/gu, "following an assistant proposal"]
]

export const rewriteChatCitations = (
  body: string,
  chats: ReadonlyMap<string, CitedChat>,
  now: Date
): string => {
  const cited = body.replace(
    POINTER,
    (whole: string, publicRef: string, sequences: string, trailing: string) => {
      const chat = chats.get(publicRef)
      if (chat === undefined) return whole
      const dates = sequencesIn(`${sequences} ${trailing}`).flatMap((sequence) => {
        const sent = chat.sentAt.get(sequence)
        return sent === undefined ? [] : [sent]
      })
      return chatCitation(chat, evidenceDateLabel(dates, now))
    }
  )
  return MISSING_DATE.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    cited
  )
}
