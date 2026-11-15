import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { countOf } from "@arden-hq/std/count"
import { DateTime, Effect, type Schema } from "effect"
import { randomUUID } from "node:crypto"

import {
  commitWiki,
  createPage,
  requireCommitRules,
  updatePage,
  type WikiCommitOrigin,
  type WikiPageOperation
} from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { formatWikiPage, reviseWikiPage } from "./page.js"
import {
  claimKey,
  MAX_CLAIM_CHARS,
  MIN_CLAIM_WORDS,
  type OpenRetraction,
  type Retraction,
  readRetraction,
  RETRACTIONS_KEY,
  storedRetractions
} from "./retraction.js"
import { loadSnapshot, type PageRecord, type Snapshot } from "./snapshot.js"
import { FORGOTTEN_PAGE_PATH, isSystemPage } from "./system-pages.js"

/** The owner's turn that asks: its chat and the chat's link. */
interface OwnerTurn {
  readonly sessionId: string
  readonly chat: string
}

interface WikiForgetInput {
  readonly lines: ReadonlyArray<string>
  readonly claim: string
  readonly turn: OwnerTurn
}

interface WikiUndoForgetInput {
  readonly id: number
  readonly turn: OwnerTurn
}

/** One page a forget or an undo changes, with its body before and after. */
interface PageChange {
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface RetractionChange {
  readonly entry: Retraction
  readonly pages: ReadonlyArray<PageChange>
}

export interface WikiForgetMethods {
  /** What a forget would change, for the owner to approve. Refused by every rule the forget is. */
  readonly planForget: (input: WikiForgetInput) => Effect.Effect<RetractionChange, WikiError>
  /** Removes every copy of the lines on every page and opens a retraction, in one commit. */
  readonly forget: (input: WikiForgetInput) => Effect.Effect<RetractionChange, WikiError>
  readonly planUndoForget: (
    input: WikiUndoForgetInput
  ) => Effect.Effect<RetractionChange, WikiError>
  /** Closes an open retraction, so its lines may be written again. */
  readonly undoForget: (input: WikiUndoForgetInput) => Effect.Effect<RetractionChange, WikiError>
}

interface Plan {
  readonly change: RetractionChange
  readonly head: string | null
  readonly operations: ReadonlyArray<WikiPageOperation>
}

const forgetOrigin = (turn: OwnerTurn): WikiCommitOrigin => ({
  kind: "forget",
  sessionId: turn.sessionId
})

const FORGOTTEN_TITLE = "Forgotten"
const FORGOTTEN_INTRO = [
  "Lines you asked Arden to forget. Arden refuses any write but yours that would put one back; ask in a chat to undo an entry.",
  "The lines stay listed here and stay in each page's history.",
  "Arden rewrites this page from its entries on each forget or undo, so change an entry in the frontmatter, not in this text."
].join(" ")

const said = (turn: { readonly chat: string; readonly at: string }): string =>
  `in [a chat](${turn.chat}) on ${turn.at.slice(0, 10)}`

const renderForgotten = (stored: ReadonlyArray<Schema.Json>): string => {
  const entries = storedRetractions({ [RETRACTIONS_KEY]: [...stored] }).entries
  const unreadable = stored.length - entries.length
  const sections = [
    FORGOTTEN_INTRO,
    ...(unreadable === 0
      ? []
      : [
          `${countOf(unreadable, "entry")} in this page's frontmatter ${unreadable === 1 ? "does not read, so its" : "do not read, so their"} lines are not guarded.`
        ]),
    ...entries.map((entry) =>
      [
        `## ${entry.id}. ${entry.claim}`,
        "",
        entry.status === "open"
          ? `Open. Asked ${said(entry.said)}.`
          : `Undone ${said(entry.closed)}. Asked ${said(entry.said)}.`,
        "",
        ...entry.removed.map((removed) => `- \`${removed.path}\`: ${removed.line}`)
      ].join("\n")
    )
  ]
  return `${sections.join("\n\n")}\n`
}

const forgottenPage = (snapshot: Snapshot): PageRecord | undefined =>
  snapshot.pages.find(
    (record) => record.resource.path === FORGOTTEN_PAGE_PATH && record.page.lifecycle === "active"
  )

/** The forgotten page storing `stored`, entries the owner wrote that do not read kept as they are. */
const withEntries = (
  current: PageRecord | undefined,
  stored: ReadonlyArray<Schema.Json>
): { readonly operation: WikiPageOperation; readonly change: PageChange } => {
  const body = renderForgotten(stored)
  const page = {
    pageId: current?.page.pageId ?? randomUUID(),
    title: current?.page.title ?? FORGOTTEN_TITLE,
    aliases: current?.page.aliases ?? [],
    lifecycle: "active" as const,
    redirectTo: null,
    metadata: { ...current?.page.metadata, [RETRACTIONS_KEY]: [...stored] },
    body
  }
  const content = formatWikiPage(page)
  return {
    operation:
      current === undefined
        ? createPage(page.pageId, FORGOTTEN_PAGE_PATH, content)
        : updatePage(current.resource, content),
    change: { path: FORGOTTEN_PAGE_PATH, before: current?.page.body ?? "", after: body }
  }
}

const forgetPlan = Effect.fn("Wiki.forgetPlan")(function* (
  snapshot: Snapshot,
  input: WikiForgetInput
): Effect.fn.Return<Plan, WikiError> {
  const claim = input.claim.trim().replace(/\s+/gu, " ")
  if (claim === "" || claim.length > MAX_CLAIM_CHARS)
    return yield* wikiError(
      "forget",
      "invalid",
      `Give the claim as one line of 1 to ${MAX_CLAIM_CHARS} characters; it is shown whenever a write is refused for it.`
    )
  const keys = input.lines.map((line) => claimKey(line))
  const short = keys.findIndex((key) => key === undefined)
  if (short >= 0)
    return yield* wikiError(
      "forget",
      "invalid",
      `Line ${short + 1} has fewer than ${MIN_CLAIM_WORDS} words, so it carries no claim to guard. Pass whole page lines.`
    )
  const wanted = new Set(keys.flatMap((key) => key ?? []))
  const pages = snapshot.pages.filter(
    (record) =>
      record.resource.state === "active" &&
      record.page.lifecycle === "active" &&
      !isSystemPage(record.resource.path)
  )
  const removed: Array<{ readonly path: string; readonly line: string }> = []
  const changes: Array<PageChange> = []
  const operations: Array<WikiPageOperation> = []
  for (const record of pages) {
    const lines = record.page.body.split("\n")
    const kept = lines.filter((line) => !wanted.has(claimKey(line) ?? ""))
    if (kept.length === lines.length) continue
    const body = kept.join("\n")
    if (body.trim() === "")
      return yield* wikiError(
        "forget",
        "invalid",
        `Forgetting these lines would leave ${record.resource.path} empty. Archive that page instead.`,
        { pageId: record.page.pageId }
      )
    for (const line of lines)
      if (wanted.has(claimKey(line) ?? "")) removed.push({ path: record.resource.path, line })
    changes.push({ path: record.resource.path, before: record.page.body, after: body })
    const content = yield* reviseWikiPage(record.page, { body }).pipe(
      Effect.mapError((cause) =>
        wikiError("forget", "invalid", `${record.resource.path} could not be rewritten.`, {
          pageId: record.page.pageId,
          cause
        })
      )
    )
    operations.push(updatePage(record.resource, content))
  }
  const missing = keys.findIndex((key) => !removed.some((line) => claimKey(line.line) === key))
  if (missing >= 0)
    return yield* wikiError(
      "forget",
      "not_found",
      `Line ${missing + 1} is on no Memory page. Pass each line exactly as a page holds it.`
    )
  const current = forgottenPage(snapshot)
  const { stored, entries } = storedRetractions(current?.page.metadata ?? {})
  const entry: OpenRetraction = {
    id: entries.reduce((last, existing) => Math.max(last, existing.id), 0) + 1,
    status: "open",
    said: { chat: input.turn.chat, at: DateTime.formatIso(yield* DateTime.now) },
    claim,
    removed
  }
  const page = withEntries(current, [...stored, entry])
  return {
    change: { entry, pages: [...changes, page.change] },
    head: snapshot.head,
    operations: [...operations, page.operation]
  }
})

const undoPlan = Effect.fn("Wiki.undoPlan")(function* (
  snapshot: Snapshot,
  input: WikiUndoForgetInput
): Effect.fn.Return<Plan, WikiError> {
  const current = forgottenPage(snapshot)
  const { stored, entries } = storedRetractions(current?.page.metadata ?? {})
  const open = entries.find((entry) => entry.id === input.id)
  if (current === undefined || open === undefined || open.status !== "open") {
    const listed = entries.filter((entry) => entry.status === "open")
    return yield* wikiError(
      "forget",
      "not_found",
      listed.length === 0
        ? `No entry ${input.id} is open; nothing is forgotten now.`
        : `No entry ${input.id} is open. Open entries: ${listed.map((entry) => `${entry.id} (${entry.claim})`).join("; ")}.`
    )
  }
  const entry: Retraction = {
    ...open,
    status: "closed",
    closed: { chat: input.turn.chat, at: DateTime.formatIso(yield* DateTime.now) }
  }
  const page = withEntries(
    current,
    stored.map((existing) => (readRetraction(existing)?.id === input.id ? entry : existing))
  )
  return {
    change: { entry, pages: [page.change] },
    head: snapshot.head,
    operations: [page.operation]
  }
})

export const makeWikiForgetMethods = (
  repository: ManagedFileRepositoryShape
): WikiForgetMethods => {
  const planned = (
    turn: OwnerTurn,
    plan: (snapshot: Snapshot) => Effect.Effect<Plan, WikiError>
  ): Effect.Effect<Plan, WikiError> =>
    loadSnapshot(repository, "forget").pipe(
      Effect.flatMap(plan),
      Effect.tap((planned) =>
        requireCommitRules(repository, forgetOrigin(turn), planned.operations).pipe(
          Effect.mapError(mapRevisionError("forget"))
        )
      )
    )

  const apply = (turn: OwnerTurn, reason: string, plan: Plan) =>
    commitWiki(
      repository,
      {
        actor: "user:chat",
        origin: forgetOrigin(turn),
        reason,
        expectedRevision: plan.head
      },
      plan.operations
    ).pipe(Effect.mapError(mapRevisionError("forget")), Effect.as(plan.change))

  return {
    planForget: (input) =>
      planned(input.turn, (snapshot) => forgetPlan(snapshot, input)).pipe(
        Effect.map((plan) => plan.change)
      ),
    forget: (input) =>
      planned(input.turn, (snapshot) => forgetPlan(snapshot, input)).pipe(
        Effect.flatMap((plan) => apply(input.turn, `forget entry ${plan.change.entry.id}`, plan))
      ),
    planUndoForget: (input) =>
      planned(input.turn, (snapshot) => undoPlan(snapshot, input)).pipe(
        Effect.map((plan) => plan.change)
      ),
    undoForget: (input) =>
      planned(input.turn, (snapshot) => undoPlan(snapshot, input)).pipe(
        Effect.flatMap((plan) => apply(input.turn, `undo forgotten entry ${input.id}`, plan))
      )
  }
}
