import { parseJsonText } from "../common/json-text.js"
import { fromMarkdown } from "mdast-util-from-markdown"

type Root = ReturnType<typeof fromMarkdown>
type Nodes = Root | Root["children"][number]

const MARKDOWN_NODE = {
  code: "code",
  listItem: "listItem",
  blockquote: "blockquote"
} as const satisfies Readonly<Record<string, Nodes["type"]>>

type MarkdownNode = (typeof MARKDOWN_NODE)[keyof typeof MARKDOWN_NODE]

const NESTING_NODES: ReadonlySet<Nodes["type"]> = new Set<MarkdownNode>([
  MARKDOWN_NODE.listItem,
  MARKDOWN_NODE.blockquote
])

const ANSWER_UI_FENCE = "arden:ui"

export interface AnswerBlockFence {
  readonly body: string
  readonly start: number
  readonly end: number
  readonly nested: boolean
}

export const answerBlockFences = (markdown: string): ReadonlyArray<AnswerBlockFence> => {
  if (!markdown.includes(ANSWER_UI_FENCE)) return []
  const fences: Array<AnswerBlockFence> = []
  const visit = (node: Nodes, nested: boolean): void => {
    if (node.type === MARKDOWN_NODE.code && node.lang === ANSWER_UI_FENCE) {
      const { start, end } = node.position ?? {}
      if (start?.offset !== undefined && end?.offset !== undefined)
        fences.push({ body: node.value, start: start.offset, end: end.offset, nested })
    }
    const inside = nested || NESTING_NODES.has(node.type)
    if ("children" in node) for (const child of node.children) visit(child, inside)
  }
  visit(fromMarkdown(markdown), false)
  return fences
}

export const answerBlockBodies = (markdown: string): ReadonlyArray<string> =>
  answerBlockFences(markdown).map((fence) => fence.body)

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

export const answerBlockTitle = (body: string): string | undefined => {
  const literal = HEADER_TITLE.exec(body)?.[1]
  if (literal === undefined) return undefined
  try {
    const title = (parseJsonText(`"${literal}"`) as string).trim()
    return title.length === 0 ? undefined : title
  } catch {
    return undefined
  }
}

export const answerBlockLabel = (body: string): string => {
  const title = answerBlockTitle(body)
  return title === undefined ? "[interactive block]" : `[interactive block: ${title}]`
}
