/** `arden:ui` answer blocks: where they sit in a message, and what they stand
 *  as in places that never draw them (a row's preview line, search text, the
 *  model's older history, the clipboard). This is the one definition of "a
 *  block" for the server, the desktop and every text view: the fences
 *  CommonMark reads as code whose language is `arden:ui`, in document order. A
 *  block's index is its place in that list, so every side names a block by
 *  (message, index) the same way. */
import { fromMarkdown } from "mdast-util-from-markdown"

type Root = ReturnType<typeof fromMarkdown>
/** Any Markdown node: the root or any content node under it. */
type Nodes = Root | Root["children"][number]

const ANSWER_UI_FENCE = "arden:ui"

/** One `arden:ui` fence of a message: its body and where the whole fence sits. */
export interface AnswerBlockFence {
  readonly body: string
  /** Offsets of the fence, opening line through closing line, in the message.
   *  An unclosed fence runs to the end of the message. */
  readonly start: number
  readonly end: number
  /** The fence sits inside a list item or a quote, not at the message's top level. */
  readonly nested: boolean
}

/** The `arden:ui` fences of a message, in the order they appear, read as the
 *  desktop's Markdown renderer reads them: an info string's extra words, a
 *  longer closing fence, a fence inside a quote or a list all count the same. */
export const answerBlockFences = (markdown: string): ReadonlyArray<AnswerBlockFence> => {
  if (!markdown.includes(ANSWER_UI_FENCE)) return []
  const fences: Array<AnswerBlockFence> = []
  const visit = (node: Nodes, nested: boolean): void => {
    if (node.type === "code" && node.lang === ANSWER_UI_FENCE) {
      const { start, end } = node.position ?? {}
      if (start?.offset !== undefined && end?.offset !== undefined)
        fences.push({ body: node.value, start: start.offset, end: end.offset, nested })
    }
    const inside = nested || node.type === "listItem" || node.type === "blockquote"
    if ("children" in node) for (const child of node.children) visit(child, inside)
  }
  visit(fromMarkdown(markdown), false)
  return fences
}

/** The bodies of a message's `arden:ui` fences, in the order they appear. */
export const answerBlockBodies = (markdown: string): ReadonlyArray<string> =>
  answerBlockFences(markdown).map((fence) => fence.body)

/** The text with each `arden:ui` fence, markers included, replaced by what
 *  `replace` returns for the fence's body and its index among the message's
 *  blocks. */
export const replaceAnswerBlocks = (
  markdown: string,
  replace: (body: string, index: number) => string
): string => {
  const fences = answerBlockFences(markdown)
  if (fences.length === 0) return markdown
  let out = ""
  let from = 0
  fences.forEach((fence, index) => {
    out += markdown.slice(from, fence.start) + replace(fence.body, index)
    from = fence.end
  })
  return out + markdown.slice(from)
}

const HEADER_TITLE = /\bHeader\(\s*"((?:[^"\\\n]|\\.)*)"/

/** A block's title: the first `Header("…")` written as a plain string. A
 *  computed title, or no Header at all, has none. */
export const answerBlockTitle = (body: string): string | undefined => {
  const literal = HEADER_TITLE.exec(body)?.[1]
  if (literal === undefined) return undefined
  try {
    const title = (JSON.parse(`"${literal}"`) as string).trim()
    return title.length === 0 ? undefined : title
  } catch {
    return undefined
  }
}

/** One short line a block stands as where only words fit: its title, or a
 *  plain mark when it has none. */
export const answerBlockLabel = (body: string): string => {
  const title = answerBlockTitle(body)
  return title === undefined ? "[interactive block]" : `[interactive block: ${title}]`
}
