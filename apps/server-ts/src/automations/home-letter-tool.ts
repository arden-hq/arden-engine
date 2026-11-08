import { createTool, createToolset, ToolExecutionError, type Toolset } from "@arden-hq/loop"
import type { HomeLetterBody } from "@arden-hq/protocol/runs"
import { Schema } from "effect"
import { fromMarkdown } from "mdast-util-from-markdown"
import { TOOL_DISPLAY_TITLE } from "../execution/tool-call-presentation.js"
import { mergeToolsets } from "../execution/toolset-middleware.js"
import { errorMessage } from "@arden-hq/std/errors"

interface MarkdownNode {
  readonly type: string
  readonly value?: string | undefined
  readonly url?: string | undefined
  readonly title?: string | null | undefined
  readonly children?: ReadonlyArray<MarkdownNode> | undefined
}

const TOOL_NAME = "publish_home_letter"
const MarkdownSchema = Schema.Struct({
  markdown: Schema.String.check(Schema.isMaxLength(5_000)).annotate({
    description:
      "Zero, one, or two short Markdown paragraphs. Only plain text and inline links to supplied evidence IDs are allowed. Use an empty string when there is nothing useful to add."
  })
})

const tool = createTool({
  name: TOOL_NAME,
  description:
    "Publish the Home letter and end the run. Link only the smallest meaningful phrases, using exact evidence IDs as Markdown destinations, for example [release review](task:123). Plain text needs no link. Call this exactly once, including with empty markdown when no update is useful.",
  parameters: Schema.toStandardSchemaV1(MarkdownSchema),
  metadata: {
    display_name: "Publish Home letter",
    kind: "tool",
    action: "write",
    source: "_home",
    changes_state: false,
    concurrency_group: null,
    destructive: false,
    default_approval: "approve",
    internal_catalog: true,
    ends_turn: true
  },
  execute: async ({ markdown }) => {
    let body: HomeLetterBody
    try {
      body = parseHomeLetterMarkdown(markdown)
    } catch (cause) {
      throw new ToolExecutionError(errorMessage(cause, "Invalid Home letter Markdown"), {
        preview: "Home letter needs correction",
        retryable: false
      })
    }
    return {
      result: JSON.stringify(body),
      preview: body.paragraphs.length === 0 ? "No Home update" : "Home letter ready",
      data: { body }
    }
  }
})

const bindHomeToolset = createToolset([tool], {
  toJsonSchema: (schema: Schema.Constraint): Record<string, unknown> =>
    Schema.toJsonSchemaDocument(schema).schema,
  displayTitle: TOOL_DISPLAY_TITLE
})

export const withHomeLetterTool = (base: Toolset): Toolset =>
  mergeToolsets(base, { toolset: bindHomeToolset(undefined), names: new Set([TOOL_NAME]) })

type Segment = HomeLetterBody["paragraphs"][number][number]

const plainText = (node: MarkdownNode): string => {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? ""
  if (node.type === "break") return " "
  if (node.type === "emphasis" || node.type === "strong" || node.type === "delete") {
    return (node.children ?? []).map(plainText).join("")
  }
  throw new Error("Only plain text and inline Markdown links with plain-text labels are allowed")
}

const toSegment = (node: MarkdownNode): Segment => {
  if (node.type !== "link") return { text: plainText(node), source_id: null }
  if (node.url === undefined || node.url.length === 0 || node.title !== null) {
    throw new Error("Links need an evidence ID destination and no title")
  }
  return { text: (node.children ?? []).map(plainText).join(""), source_id: node.url }
}

const mergePlainSegments = (segments: ReadonlyArray<Segment>): Array<Segment> =>
  segments.reduce<Array<Segment>>((merged, segment) => {
    const last = merged.at(-1)
    if (last !== undefined && last.source_id === null && segment.source_id === null) {
      merged[merged.length - 1] = { text: last.text + segment.text, source_id: null }
    } else {
      merged.push(segment)
    }
    return merged
  }, [])

const parseHomeLetterMarkdown = (markdown: string): HomeLetterBody => {
  const root: MarkdownNode = fromMarkdown(markdown)
  if (root.children === undefined || root.children.length === 0) return { paragraphs: [] }
  if (root.children.length > 2 || root.children.some((node) => node.type !== "paragraph")) {
    throw new Error(
      "Use at most two plain paragraphs; headings, lists, code, and HTML are not allowed"
    )
  }
  const paragraphs = root.children.map((paragraph) => {
    const segments = mergePlainSegments((paragraph.children ?? []).map(toSegment))
    if (segments.length === 0 || segments.length > 12) {
      throw new Error("Each paragraph must contain between one and twelve text or link segments")
    }
    return segments
  })
  for (const segment of paragraphs.flat()) {
    if (segment.text.length === 0 || segment.text.length > 500) {
      throw new Error("Each text or link segment must contain between 1 and 500 characters")
    }
  }
  if (paragraphs.flat().reduce((length, segment) => length + segment.text.length, 0) > 1_200) {
    throw new Error("The Home letter must contain at most 1,200 visible characters")
  }
  return { paragraphs }
}
