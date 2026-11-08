import type { HomeEvidence, HomeLetterBody } from "@arden-hq/protocol/runs"
import { fromMarkdown } from "mdast-util-from-markdown"
import { Effect } from "effect"
import type { HomeAddressBook, HomeAddressNeeds } from "../persistence/home/model.js"
import type { HomeStore } from "../persistence/home/store.js"

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
    case "task":
      return [entry.title, entry.summary]
    case "run":
      return [entry.text]
    case "approval":
      return [entry.preview]
    case "question":
      return [entry.question.content.prompt, entry.question.content.detail]
    case "offer":
      return []
  }
}

const plain = (node: MarkdownNode): string =>
  node.value ?? (node.children ?? []).map(plain).join("")

function* linksIn(node: MarkdownNode): Generator<MarkdownNode> {
  if (node.type === "link") yield node
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
        if (entry.kind === "question") {
          const origin = entry.question.context.origin
          return [origin.kind === "chat" ? origin.session_id : entry.question.session_id]
        }
        return entry.kind === "task" || entry.kind === "offer" ? [] : [entry.session_id]
      })
    )
  ],
  runIds: [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === "run" || entry.kind === "approval" ? [entry.run_id] : []
      )
    )
  ]
})

const task = (itemId: string) => `arden:task/${encodeURIComponent(itemId)}`

function evidenceHref(entry: HomeEvidence, book: HomeAddressBook): string | null {
  const turn = (sessionId: string, turnId: string | undefined): string | null => {
    const ref = book.sessionRefs.get(sessionId)
    if (ref === undefined) return null
    const session = `arden:session/${encodeURIComponent(ref)}`
    return turnId === undefined ? session : `${session}/${encodeURIComponent(turnId)}`
  }
  switch (entry.kind) {
    case "task":
      return task(entry.item_id)
    case "question": {
      const { context, session_id, turn_id } = entry.question
      if (context.task) return task(context.task.item_id)
      return context.origin.kind === "chat"
        ? turn(context.origin.session_id, context.origin.turn_id)
        : turn(session_id, turn_id)
    }
    case "run":
    case "approval": {
      if (entry.context?.task) return task(entry.context.task.item_id)
      if (entry.context?.origin.kind === "automation") return null
      return turn(entry.session_id, book.runTurns.get(entry.run_id))
    }
    case "offer":
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
