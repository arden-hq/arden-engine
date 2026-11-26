import { HOME_EVIDENCE } from "../persistence/home/letter-schema.js"
import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { MARKDOWN_NODE } from "../wiki/markdown-node.js"
import { type HomeEvidence, type HomeLetterBody } from "../persistence/home/letter-schema.js"
import { fromMarkdown } from "mdast-util-from-markdown"
import { Effect } from "effect"
import type { HomeAddressBook, HomeAddressNeeds } from "../persistence/home/model.js"
import type { HomeStore } from "../persistence/home/store.js"
import { chatHref } from "../sessions/chat-href.js"

interface MarkdownNode {
  readonly type: string
  readonly value?: string | undefined
  readonly url?: string | undefined
  readonly children?: ReadonlyArray<MarkdownNode> | undefined
}

export interface HomeLink {
  readonly id: string
  readonly source_id: string
  readonly label: string
  readonly href: string
}

const PLACE = /^(?:https?:|file:|arden:(?!automation\b))/i

const proseOf = (entry: HomeEvidence): ReadonlyArray<string | null> => {
  switch (entry.kind) {
    case HOME_EVIDENCE.task:
      return [entry.title, entry.summary]
    case HOME_EVIDENCE.run:
      return [entry.text]
    case HOME_EVIDENCE.approval:
      return [entry.preview]
    case HOME_EVIDENCE.question:
      return [entry.question.content.prompt, entry.question.content.detail]
    case HOME_EVIDENCE.offer:
      return []
  }
}

const plain = (node: MarkdownNode): string =>
  node.value ?? (node.children ?? []).map(plain).join("")

function* linksIn(node: MarkdownNode): Generator<MarkdownNode> {
  if (node.type === MARKDOWN_NODE.link) yield node
  for (const child of node.children ?? []) yield* linksIn(child)
}

export function homeLinks(entries: readonly HomeEvidence[]): HomeLink[] {
  const links: HomeLink[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const text of proseOf(entry)) {
      if (!text) continue
      for (const node of linksIn(fromMarkdown(text))) {
        const href = node.url ?? ""
        const label = plain(node).trim()
        if (!PLACE.test(href) || label.length === 0 || seen.has(href)) continue
        seen.add(href)
        links.push({ id: `link:${links.length + 1}`, source_id: entry.id, label, href })
      }
    }
  }
  return links
}

const homeAddressNeeds = (entries: readonly HomeEvidence[]): HomeAddressNeeds => ({
  sessionIds: [
    ...new Set(
      entries.flatMap((entry) => {
        if (entry.kind === HOME_EVIDENCE.question) {
          const origin = entry.question.context.origin
          return [origin.kind === RUN_ORIGIN.chat ? origin.session_id : entry.question.session_id]
        }
        return entry.kind === HOME_EVIDENCE.task || entry.kind === HOME_EVIDENCE.offer
          ? []
          : [entry.session_id]
      })
    )
  ],
  runIds: [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === HOME_EVIDENCE.run || entry.kind === HOME_EVIDENCE.approval
          ? [entry.run_id]
          : []
      )
    )
  ]
})

const task = (itemId: string) => `arden:task/${encodeURIComponent(itemId)}`

function evidenceHref(entry: HomeEvidence, book: HomeAddressBook): string | null {
  const turn = (sessionId: string, turnId: string | undefined): string | null => {
    const ref = book.sessionRefs.get(sessionId)
    if (ref === undefined) return null
    return chatHref(turnId === undefined ? { publicRef: ref } : { publicRef: ref, turnId })
  }
  switch (entry.kind) {
    case HOME_EVIDENCE.task:
      return task(entry.item_id)
    case HOME_EVIDENCE.question: {
      const { context, session_id, turn_id } = entry.question
      if (context.task) return task(context.task.item_id)
      return context.origin.kind === RUN_ORIGIN.chat
        ? turn(context.origin.session_id, context.origin.turn_id)
        : turn(session_id, turn_id)
    }
    case HOME_EVIDENCE.run:
    case HOME_EVIDENCE.approval: {
      if (entry.context?.task) return task(entry.context.task.item_id)
      if (entry.context?.origin.kind === RUN_ORIGIN.automation) return null
      return turn(entry.session_id, book.runTurns.get(entry.run_id))
    }
    case HOME_EVIDENCE.offer:
      return null
  }
}

function addressHomeLetter(
  body: HomeLetterBody,
  entries: readonly HomeEvidence[],
  book: HomeAddressBook
): HomeLetterBody {
  const all = homeLinks(entries)
  const links = new Map(all.map((link) => [link.id, link]))
  const evidence = new Map(entries.map((entry) => [entry.id, entry]))
  const named = (sourceId: string, text: string) => {
    const words = text.trim().toLowerCase()
    return all.find((link) => link.source_id === sourceId && link.label.toLowerCase() === words)
  }
  return {
    paragraphs: body.paragraphs.map((paragraph) =>
      paragraph.map((segment) => {
        if (segment.source_id === null) return segment
        const link = links.get(segment.source_id)
        if (link) return { text: segment.text, source_id: link.source_id, href: link.href }
        const entry = evidence.get(segment.source_id)
        const place = named(segment.source_id, segment.text)?.href
        return {
          text: segment.text,
          source_id: segment.source_id,
          href: place ?? (entry ? evidenceHref(entry, book) : null)
        }
      })
    )
  }
}

export const addressedHomeLetter = Effect.fn("addressedHomeLetter")(function* (
  home: HomeStore["Service"]
) {
  const view = yield* home.homeLetter()
  const book = yield* home.homeAddressBook(
    homeAddressNeeds(view.letters.flatMap((letter) => letter.sources))
  )
  return {
    ...view,
    letters: view.letters.map((letter) => ({
      ...letter,
      body: addressHomeLetter(letter.body, letter.sources, book)
    }))
  }
})
