import { cutText } from "@arden-hq/std/text"
import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Array as Arr, Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { writeIdentity, type WikiWriteIdentity } from "./wiki-identity.js"
import type { ServerRunContext } from "./run-context.js"
import type { WikiLocationAuthority } from "../wiki/authority.js"
import type { WikiCommitIdentity } from "../wiki/commit.js"
import { captureReplayKey } from "../wiki/capture.js"
import type { WikiError } from "../wiki/errors.js"
import { ObservationPeriodSchema } from "../wiki/observation-period.js"
import { outsideEditNotice } from "../wiki/outside-edits.js"
import { nameKeys, namesTakenAt, normal, reviseWikiPage } from "../wiki/page.js"
import { loadPageAges, PAGE_AGE_RULE } from "../wiki/page-age.js"
import { Wiki } from "../wiki/service.js"
import {
  activeRunPages,
  redirectTargetAt,
  type PageRecord,
  type Snapshot
} from "../wiki/snapshot.js"
import { bodyFields } from "./code-mode-result.js"
import { readTextPage } from "./read-text.js"
import { recordApplied, type CallEffects } from "../execution/tool-effect.js"
import {
  MAX_PAGE_SOURCES,
  memorySource,
  pageReceipt,
  pagesReceipt,
  reportProvenanceLines,
  requireObserved
} from "./wiki-records.js"
import {
  CORE_CONDENSE_ADVICE,
  coreCondenseTarget,
  coreNeedsCondensing,
  corePageBudget,
  STANDING_LIMIT_NOTE
} from "../memory/core-memory.js"

const MAX_PAGE_LINES = 4_000
export const MAX_WIKI_CONTENT_CHARS = 40_000
export const WIKI_PAGE_BUDGET_CHARS = 32_000

const MAX_LIST_ENTRIES = 200

export const WikiPathSchema = Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
  description: "Exact relative POSIX .md path of the wiki page, such as 'projects/dex.md'."
})

const ListParametersSchema = Schema.Struct({
  directory: Schema.String.check(Schema.isMaxLength(4_096))
    .annotate({
      description: "Exact wiki directory, such as 'areas'. Empty means the wiki root."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  offset: Schema.Natural.annotate({
    description: "Zero-based entry offset from a prior list result."
  }).pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIST_ENTRIES }))
    .annotate({
      description: `Maximum entries to return, from 1 to ${MAX_LIST_ENTRIES}. Defaults to 100.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(100)))
})

const ReadParametersSchema = Schema.Struct({
  path: WikiPathSchema,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "One-based first line to return. Defaults to 1."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LINES }))
    .annotate({
      description: `Maximum lines to return, from 1 to ${MAX_PAGE_LINES}. Defaults to 500.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(500)))
})

const CreateParametersSchema = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMinLength(4), Schema.isMaxLength(4_096)).annotate({
    description:
      "Relative POSIX .md path inside an existing wiki directory, or a root profile page named in the tool description."
  }),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
    description: "Human-readable page title."
  }),
  body: Schema.String.check(
    Schema.isPattern(/\S/u),
    Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)
  ).annotate({
    description:
      "Required Markdown body with useful content, not an empty or title-only placeholder."
  })
})

const PageEditSchema = Schema.Struct({
  path: WikiPathSchema,
  body: Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS))
    .annotate({
      description: "Complete replacement Markdown body. Omit to preserve the body."
    })
    .pipe(Schema.optionalKey),
  observation_period: Schema.optionalKey(
    ObservationPeriodSchema.pipe(
      Schema.annotateEncoded({
        description:
          "Evidence-backed correction of the stored observation interval. Omit to preserve it. Producer and source attribution cannot be changed."
      })
    )
  ),
  aliases: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(4_096)))
      .check(Schema.isMaxLength(100))
      .annotate({
        description:
          "Complete replacement alias list: other names people use for this subject, never paths. [] removes all aliases. Omit to preserve aliases. A moved or merged page's old path keeps opening it on its own."
      })
  )
}).check(
  Schema.makeFilter((input) =>
    input.body !== undefined ||
    input.aliases !== undefined ||
    input.observation_period !== undefined
      ? undefined
      : "Provide body, aliases or observation_period"
  )
)

const EditParametersSchema = Schema.Struct({
  ...PageEditSchema.fields,
  path: WikiPathSchema.pipe(Schema.optionalKey),
  edits: Schema.optionalKey(
    Schema.NonEmptyArray(PageEditSchema).check(Schema.isMaxLength(12)).annotate({
      description:
        "Edits of several pages, from 1 to 12, saved together: all or none. Give these instead of path and its fields."
    })
  )
}).check(
  Schema.makeFilter((input) => {
    const fields = [input.body, input.aliases, input.observation_period]
    if (input.edits !== undefined)
      return input.path === undefined && fields.every((field) => field === undefined)
        ? undefined
        : "Give edits, or path and its fields, not both"
    if (input.path === undefined) return "Give path, or edits"
    return fields.some((field) => field !== undefined)
      ? undefined
      : "Provide body, aliases or observation_period"
  })
)

export const wikiFailure = (error: WikiError): ToolExecutionError => {
  switch (error.reason) {
    case "not_found":
      return new ToolExecutionError(
        `${error.message} Call wiki_list_pages and retry with an exact active page path.`,
        { preview: "Memory page not found", retryable: false }
      )
    case "conflict":
      return new ToolExecutionError(
        "Memory changed after it was read. Read the relevant page again, then retry.",
        { preview: "Memory changed", retryable: true }
      )
    case "blocked":
      return new ToolExecutionError(error.message, {
        preview: "Memory write blocked",
        retryable: false
      })
    case "invalid":
      return new ToolExecutionError(
        `The Memory page path, metadata, or Markdown body is invalid: ${error.message}`,
        { preview: "Invalid Memory page", retryable: false }
      )
    case "closed":
      return new ToolExecutionError("Memory is closed because Arden is shutting down.", {
        preview: "Memory closed",
        retryable: false
      })
    case "corrupt":
      return new ToolExecutionError(error.message, {
        preview: "Memory storage failed",
        retryable: false
      })
    case "storage":
      return new ToolExecutionError(error.message, {
        preview: "Memory storage failed",
        retryable: true
      })
  }
}

const parseDirectory = (value: string): string | null => {
  if (value === "") return ""
  if (value.startsWith("/")) return null
  if (value.includes("\\")) return null
  const directory = value.endsWith("/") ? value.slice(0, -1) : value
  if (directory === "") return null
  const parts = directory.split("/")
  if (parts.some((part) => part === "")) return null
  if (parts.some((part) => part === "." || part === "..")) return null
  return directory
}

export const activePage = (snapshot: Snapshot, path: string): PageRecord | null => {
  const pages = activeRunPages(snapshot.pages)
  const direct = pages.find((record) => record.resource.path === path)
  if (direct !== undefined) return direct
  const wanted = normal(path)
  return pages.find((record) => nameKeys(record.resource.path).includes(wanted)) ?? null
}

export const readablePage = (snapshot: Snapshot, path: string): PageRecord | null =>
  activePage(snapshot, path) ?? redirectTargetAt(snapshot, path)

export const pageData = (record: PageRecord) => ({
  page_ref: record.page.pageId,
  revision: record.resource.versionId,
  path: record.resource.path,
  title: record.page.title,
  aliases: [...record.page.aliases],
  lifecycle: record.page.lifecycle
})

export const writtenPageData = (page: {
  readonly path: string
  readonly title: string
  readonly aliases: ReadonlyArray<string>
  readonly lifecycle: string
}) => ({
  path: page.path,
  title: page.title,
  aliases: [...page.aliases],
  lifecycle: page.lifecycle
})

interface ListingEntry {
  readonly kind: "directory" | "page"
  readonly path: string
  readonly title?: string
}

const listingEntries = (
  pages: ReadonlyArray<PageRecord>,
  directory: string
): ReadonlyArray<ListingEntry> => {
  const prefix = directory === "" ? "" : `${directory}/`
  const directories = new Set<string>()
  const entries: Array<ListingEntry> = []
  for (const record of pages) {
    const path = record.resource.path
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    if (relative === "") continue
    const separator = relative.indexOf("/")
    if (separator >= 0) {
      directories.add(`${prefix}${relative.slice(0, separator)}/`)
      continue
    }
    entries.push({ kind: "page", path, title: record.page.title })
  }
  return [
    ...[...directories].sort().map((path): ListingEntry => ({ kind: "directory", path })),
    ...entries.sort((left, right) => left.path.localeCompare(right.path))
  ]
}

export interface BoundedBody {
  readonly content: string
  readonly text: string
  readonly totalLines: number
  readonly truncated: boolean
}

export const boundedBody = (body: string, offset: number, limit: number): BoundedBody => {
  const page = readTextPage(body, { offset, limit })
  const sliced = page.content
  const truncatedByChars = sliced.length > MAX_WIKI_CONTENT_CHARS
  const content = truncatedByChars
    ? cutText(sliced, MAX_WIKI_CONTENT_CHARS, {
        suffix: `\n[truncated at ${MAX_WIKI_CONTENT_CHARS} characters]`
      })
    : [sliced, page.notice].filter(Boolean).join("\n\n")
  return {
    content,
    text: sliced,
    totalLines: page.total,
    truncated: truncatedByChars || page.hasMore
  }
}

const formatListingEntry = (entry: ListingEntry): string => {
  if (entry.kind === "directory") return `[directory] ${entry.path}`
  return `[page] ${entry.path} — ${entry.title}`
}

const renderListing = (
  directory: string,
  visible: ReadonlyArray<ListingEntry>,
  hasMore: boolean,
  nextOffset: number
): string => {
  const lines = visible.map(formatListingEntry)
  if (lines.length === 0) lines.push("No wiki entries.")
  if (hasMore) lines.push(`More entries exist; retry with offset=${nextOffset}.`)
  lines.push(
    "Link a page as [Title](path.md) when the user should open it. The answer's Sources footer already names what was read, so do not add a 'Source:' line."
  )
  const header = directory === "" ? "Wiki /" : `Wiki /${directory}/`
  return `${header}\n${lines.join("\n")}`
}

export const loadSnapshot = (wiki: Wiki["Service"], signal: AbortSignal): Promise<Snapshot> =>
  Effect.runPromise(wiki.snapshot().pipe(Effect.mapError(wikiFailure)), { signal })

const pagesWithPathAlias = (snapshot: Snapshot, path: string): ReadonlyArray<string> => {
  const wanted = namesTakenAt([path])
  return activeRunPages(snapshot.pages)
    .filter((record) => record.page.aliases.some((alias) => wanted.has(normal(alias))))
    .map((record) => record.resource.path)
}

export const pageNotFound = (snapshot: Snapshot, path: string): ToolExecutionError => {
  const redirected = redirectTargetAt(snapshot, path)
  if (redirected !== null)
    return new ToolExecutionError(
      `'${path}' now redirects to '${redirected.resource.path}'. Use '${redirected.resource.path}' to change that page.`,
      { preview: "Memory page moved", retryable: false }
    )
  const named = pagesWithPathAlias(snapshot, path).slice(0, 3)
  const hint =
    named.length === 0
      ? "Call wiki_list_pages and retry with an exact active page path."
      : `${named.map((candidate) => `'${candidate}'`).join(", ")} lists '${path}' as an earlier name; read it if it is the page you want.`
  return new ToolExecutionError(`No active Memory page exists at '${path}'. ${hint}`, {
    preview: "Memory page not found",
    retryable: false
  })
}

interface ChangedPage {
  readonly pageId: string
  readonly path: string
  readonly title: string
  readonly version: string
}

/** A page a change saved, and its version before the change. */
export interface SavedPage<Page extends ChangedPage = ChangedPage> {
  readonly page: Page
  readonly before: string
}

type Found<Paths> = { readonly [K in keyof Paths]: PageRecord }

/** The pages a run named, as it found them, and who it writes as. */
export interface PagesTarget<Paths> {
  readonly head: string
  readonly records: Found<Paths>
  readonly identity: WikiWriteIdentity
  /** This run as the writer of a change made for `reason`, as a page service verb takes it. */
  readonly writer: (reason: string) => {
    readonly authority: WikiLocationAuthority
    readonly commit: WikiCommitIdentity
  }
  /** Runs a page service call, failing as a tool fails. */
  readonly run: <A>(effect: Effect.Effect<A, WikiError>) => Promise<A>
}

export interface WikiToolServices {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}

/** A page as this run found it, saved by a change that did not need to write it. */
export const keptPage = (record: PageRecord) => ({
  page: {
    pageId: record.page.pageId,
    path: record.resource.path,
    title: record.page.title,
    version: record.resource.versionId,
    aliases: record.page.aliases,
    lifecycle: record.page.lifecycle
  },
  before: record.resource.versionId
})

const findAll = <const Paths extends Arr.NonEmptyReadonlyArray<string>>(
  paths: Paths,
  find: (path: string) => PageRecord
): Found<Paths> => paths.map(find) as unknown as Found<Paths>

/**
 * Changes the pages at `paths` as this run: finds each page, saves through `save` as this run's
 * writer, takes each saved page as the run's read of it, and receipts the pages whose version moved.
 */
export const changePages = async <
  const Paths extends Arr.NonEmptyReadonlyArray<string>,
  Page extends ChangedPage
>(
  { wiki, runs }: WikiToolServices,
  ctx: ToolContext<ServerRunContext>,
  effects: CallEffects,
  request: {
    readonly paths: Paths
    /** The page a path names; an active page unless given. */
    readonly find?: (snapshot: Snapshot, path: string) => PageRecord | null
    readonly save: (
      target: PagesTarget<Paths>
    ) => Promise<Arr.NonEmptyReadonlyArray<SavedPage<Page>>>
  }
) => {
  const snapshot = await loadSnapshot(wiki, ctx.signal)
  const head = snapshot.head
  if (head === null) throw pageNotFound(snapshot, request.paths[0])
  const records = findAll(request.paths, (path) => {
    const record = (request.find ?? activePage)(snapshot, path)
    if (record === null) throw pageNotFound(snapshot, path)
    return record
  })
  const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
  const saved = await request.save({
    head,
    records,
    identity,
    writer: (reason) => ({
      authority: identity.authority,
      commit: { actor: identity.actor, origin: identity.origin, reason }
    }),
    run: (effect) =>
      Effect.runPromise(effect.pipe(Effect.mapError(wikiFailure)), { signal: ctx.signal })
  })
  for (const { page } of saved) ctx.run.observations.observe(page.pageId, page.version)
  const moved = saved.filter(({ page, before }) => page.version !== before)
  if (moved.length > 0) effects.applied()
  else effects.unchanged()
  const [one] = moved
  return {
    records,
    saved,
    changed: one !== undefined,
    receipt:
      moved.length === 1 && one !== undefined
        ? pageReceipt({ ctx, page: one.page, beforeVersion: one.before })
        : pagesReceipt(
            ctx,
            moved.map(({ page, before }) => ({
              ...page,
              beforeVersion: before,
              afterVersion: page.version
            }))
          )
  }
}

const makeWikiTools = ({
  wiki,
  runs
}: {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_list_pages",
    description: [
      "List wiki pages and child directories inside one exact wiki directory.",
      "Empty directory means the wiki root. Link a page as [Title](path.md) when the user should open it. The answer's Sources footer already names what was read, so do not add a 'Source:' line."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ListParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "List Wiki Pages",
      kind: "tool",
      action: "read",
      approval_preview: "List Memory pages in one folder.",
      source: "_wiki",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const directory = parseDirectory(input.directory)
      if (directory === null) {
        throw new ToolExecutionError(
          "Memory folder must be a relative POSIX path without '.' or '..'. Retry with a folder such as 'areas', or empty for the root.",
          { preview: "Invalid Memory folder", retryable: false }
        )
      }
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const entries = listingEntries(activeRunPages(snapshot.pages), directory)
      if (directory !== "" && entries.length === 0) {
        throw new ToolExecutionError(
          `No active Memory folder exists at '${directory}'. List its parent folder, or create the first page under this folder.`,
          { preview: "Memory folder not found", retryable: false }
        )
      }
      const visible = entries.slice(input.offset, input.offset + input.limit)
      const nextOffset = input.offset + visible.length
      const hasMore = nextOffset < entries.length
      const source_refs = visible
        .flatMap((entry) =>
          entry.kind === "page" && entry.title !== undefined
            ? [memorySource({ path: entry.path, title: entry.title, use: "found" })]
            : []
        )
        .slice(0, MAX_PAGE_SOURCES)
      return {
        result: renderListing(directory, visible, hasMore, nextOffset),
        preview: `${countOf(visible.length, "wiki entry")}${hasMore ? " (capped)" : ""}`,
        host: { source_refs },
        data: {
          source_refs,
          directory,
          offset: input.offset,
          entries: visible.map((entry) => ({ ...entry })),
          total: entries.length,
          has_more: hasMore,
          next_offset: hasMore ? nextOffset : null
        }
      }
    }
  }),

  defineServerTool({
    name: "wiki_read_page",
    description: [
      "Read the current body of one wiki page by exact path, paginated by line. A moved or merged path reads the page that replaced it. This read is what wiki_edit_page, wiki_move_page, wiki_archive_page, wiki_merge_page and wiki_restore_page require first.",
      "After the body it lists the page_ref, any observation period, producer and original source references, the Core Memory size limit when one applies, and a README's child pages.",
      `It also says when the page last changed. ${PAGE_AGE_RULE}`
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReadParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Read Wiki Page",
      kind: "tool",
      action: "read",
      approval_preview: "Read one Memory page.",
      source: "_wiki",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = readablePage(snapshot, input.path)
      if (record === null) throw pageNotFound(snapshot, input.path)
      if (snapshot.head !== null) ctx.run.observations.observeHead(snapshot.head)
      ctx.run.observations.observe(record.page.pageId, record.resource.versionId)
      const { content, text, totalLines, truncated } = boundedBody(
        record.page.body,
        input.offset,
        input.limit
      )
      ctx.run.codeMode.scriptFields(ctx.toolCallId, () => bodyFields(text))
      const chars = record.page.body.length
      const coreBudget = corePageBudget({
        path: record.resource.path,
        pageId: record.page.pageId
      })
      const overBudget =
        coreBudget === undefined
          ? chars >= WIKI_PAGE_BUDGET_CHARS
          : coreNeedsCondensing(chars, coreBudget)
      const lastChanged = (
        await Effect.runPromise(loadPageAges(wiki, snapshot.head), { signal: ctx.signal })
      ).lines.get(record.page.pageId)
      const outside = wiki.outsideEditState(record.resource.path)
      const isReadme = input.path === "README.md" || input.path.endsWith("/README.md")
      const directory = input.path.slice(0, Math.max(0, input.path.length - "/README.md".length))
      const children = isReadme
        ? listingEntries(activeRunPages(snapshot.pages), directory).filter(
            (entry) => entry.path !== input.path
          )
        : []
      const status = [
        ...(record.resource.path === input.path ||
        nameKeys(record.resource.path).includes(normal(input.path))
          ? []
          : [`${input.path} now redirects here, to ${record.resource.path}.`]),
        `page_ref: ${record.page.pageId}`,
        ...(lastChanged === undefined ? [] : [lastChanged]),
        ...(outside === undefined ? [] : [outsideEditNotice(outside)]),
        ...reportProvenanceLines(record),
        ...(coreBudget === undefined
          ? []
          : [
              `Page size: ${chars} characters. Every run that reads Memory is sent this page whole (Core Memory), so it is limited to ${coreBudget} characters.`,
              ...(overBudget
                ? [
                    `The page is full or nearly full, and a write that grows it past that size is refused. ` +
                      `Bring it to ${coreCondenseTarget(coreBudget)} characters or fewer. ${CORE_CONDENSE_ADVICE}`
                  ]
                : [])
            ]),
        ...(overBudget && coreBudget === undefined
          ? [
              `Page size: ${chars} characters (filing budget ${WIKI_PAGE_BUDGET_CHARS}).`,
              "This page is over its filing budget. Condense repetition first, preserving evidence. " +
                "Split only when a distinct subject or reading scope warrants its own page, " +
                "then leave a contextual link; do not split merely by heading."
            ]
          : []),
        ...(children.length === 0
          ? []
          : [
              `Child pages (${children.length} total):`,
              ...children.slice(0, 20).map(formatListingEntry),
              ...(children.length > 20
                ? [
                    `Preview capped at 20 entries. Browse all entries with wiki_list_pages: directory ${JSON.stringify(directory)}, offset 0.`
                  ]
                : [])
            ])
      ]
      const source_refs = [
        memorySource({
          path: record.resource.path,
          title: record.page.title,
          use: "read",
          body: record.page.body
        })
      ]
      return {
        result: `${content}\n\n---\n${status.join("\n")}`,
        preview: record.page.title,
        host: { source_refs },
        data: {
          source_refs,
          page: pageData(record),
          offset: input.offset,
          limit: input.limit,
          total_lines: totalLines,
          content_truncated: truncated,
          chars,
          over_budget: overBudget
        }
      }
    }
  }),

  defineServerTool({
    name: "wiki_create_page",
    description: [
      "Create a new wiki page at an exact relative POSIX .md path inside an existing wiki directory.",
      `Read the root and target directory README, search for an existing owner, and supply useful content. Do not create empty placeholders. Fails if the path or page name already exists, unless that page already has exactly this title and body; then nothing changes. ${STANDING_LIMIT_NOTE}`
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(CreateParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Create Wiki Page",
      kind: "tool",
      action: "write",
      approval_preview: "Create a new Memory page.",
      source: "_wiki",
      scopes: ["memory_capture"],
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const existing = snapshot.pages.find((record) => record.resource.path === input.path)
      if (existing !== undefined) {
        if (
          existing.page.lifecycle === "active" &&
          existing.page.title === input.title &&
          existing.page.body === input.body
        ) {
          ctx.run.observations.observe(existing.page.pageId, existing.resource.versionId)
          effects.unchanged()
          return {
            result: `${input.path} already has the requested content.`,
            preview: "Wiki page unchanged",
            data: { page: pageData(existing), changed: false }
          }
        }
        throw new ToolExecutionError(
          `A Memory page already exists at '${input.path}' with different content. Read the existing page, choose another path, or edit that page instead.`,
          { preview: "Memory path already exists", retryable: false }
        )
      }
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const created = await recordApplied(
        effects,
        Effect.runPromise(
          wiki
            .create({
              path: input.path,
              title: input.title,
              body: input.body,
              authority: identity.authority,
              commit: {
                actor: identity.actor,
                origin: identity.origin,
                reason: `create wiki page ${input.path}`
              }
            })
            .pipe(Effect.mapError(wikiFailure)),
          { signal: ctx.signal }
        )
      )
      ctx.run.observations.observe(created.pageId, created.version)
      return {
        result: `Created ${created.path}.`,
        preview: "Wiki page created",
        data: { page: writtenPageData(created), changed: true },
        host: pageReceipt({ ctx, page: created, beforeVersion: "absent" })
      }
    }
  }),

  defineServerTool({
    name: "wiki_edit_page",
    description: [
      "Replace the Markdown body, aliases and/or observation_period of one existing wiki page, or of up to 12 pages saved together as edits.",
      "The page title, identity, producer attribution, source references and other metadata stay unchanged. Read each page first to base the edit on its",
      "current content; the edit fails if the wiki changed since that read.",
      `Aim for ${WIKI_PAGE_BUDGET_CHARS} characters. Condense repetition before splitting;`,
      `create another page only for a distinct subject or useful reading scope, with a contextual link. ${STANDING_LIMIT_NOTE}`
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EditParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Edit Wiki Page",
      kind: "tool",
      action: "write",
      approval_preview: "Edit Memory pages.",
      source: "_wiki",
      scopes: ["memory_capture"],
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const edits = input.edits ?? [{ ...input, path: input.path ?? "" }]
      const { records, saved, changed, receipt } = await changePages({ wiki, runs }, ctx, effects, {
        paths: Arr.map(edits, (edit) => edit.path),
        save: async ({ head, records, identity, writer, run }) => {
          const revised = await Promise.all(
            Arr.map(Arr.zip(edits, records), async ([edit, record]) => ({
              record,
              content: await Effect.runPromise(reviseWikiPage(record.page, edit), {
                signal: ctx.signal
              })
            }))
          )
          const replayKey =
            input.edits === undefined || identity.captureBatch === null
              ? undefined
              : captureReplayKey(identity.captureBatch, "patch")
          const sent = revised.filter(
            ({ record, content }) => replayKey !== undefined || content !== record.page.content
          )
          if (!Arr.isArrayNonEmpty(sent)) return Arr.map(revised, ({ record }) => keptPage(record))
          const expectedHead = replayKey === undefined ? head : ctx.run.observations.observedHead()
          if (expectedHead === undefined)
            throw new ToolExecutionError("Read every page before editing them, then retry.", {
              preview: "Read required",
              retryable: false
            })
          const sentEdits = Arr.map(sent, ({ record, content }) => ({
            pageId: record.page.pageId,
            content,
            expectedVersion: requireObserved(ctx.run, record)
          }))
          const pages = await run(
            wiki.update({
              edits: sentEdits,
              expectedHead,
              authority: identity.authority,
              commit: {
                ...writer(
                  `edit wiki page ${sent.map(({ record }) => record.resource.path).join(", ")}`
                ).commit,
                ...(replayKey === undefined ? {} : { replayKey })
              }
            })
          )
          return Arr.map(Arr.zip(pages, sentEdits), ([page, edit]) => ({
            page,
            before: edit.expectedVersion
          }))
        }
      })
      const paths = saved.map(({ page }) => page.path).join(", ")
      const [first] = records
      const [only] = saved
      return {
        ...(receipt === undefined ? {} : { host: receipt }),
        result: changed
          ? `Updated ${paths}.`
          : `${paths} already ${saved.length === 1 ? "has" : "have"} the requested content, aliases and observation period.`,
        preview: changed ? "Wiki page updated" : "Wiki page unchanged",
        data:
          input.edits !== undefined
            ? { pages: saved.map(({ page }) => writtenPageData(page)), changed }
            : {
                page: changed && only !== undefined ? writtenPageData(only.page) : pageData(first),
                changed
              }
      }
    }
  })
]

export const wikiTools = Effect.gen(function* () {
  return makeWikiTools({ wiki: yield* Wiki, runs: yield* RunQueries })
})
