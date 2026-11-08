import { cutText } from "@arden-hq/std/text"
import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { writeIdentity } from "./wiki-identity.js"
import type { WikiCommitOrigin } from "../wiki/commit.js"
import type { WikiError } from "../wiki/errors.js"
import { ObservationPeriodSchema } from "../wiki/observation-period.js"
import { normal, pageNamesForPath, reviseWikiPage } from "../wiki/page.js"
import { Wiki } from "../wiki/service.js"
import { redirectTargetAt, type PageRecord, type Snapshot } from "../wiki/snapshot.js"
import { bodyFields } from "./code-mode-result.js"
import { readTextPage } from "./read-text.js"
import { recordApplied } from "../execution/tool-effect.js"
import { MAX_PAGE_SOURCES, memorySource, pageReceipt, pagesReceipt } from "./wiki-records.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { corePageBudget } from "../memory/core-memory.js"
import { requireWithinCoreBudget } from "./wiki-records.js"

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
      "Relative POSIX .md path inside an existing wiki directory, or me.md for the root profile."
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

const EditParametersSchema = Schema.Struct({
  path: WikiPathSchema,
  body: Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS))
    .annotate({
      description: "Complete replacement Markdown body. Omit to preserve the body."
    })
    .pipe(Schema.optionalKey),
  observation_period: Schema.optionalKey(
    ObservationPeriodSchema.annotate({
      description:
        "Evidence-backed correction of the stored observation interval. Omit to preserve it. Producer and source attribution cannot be changed."
    })
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

const CapturePatchSetParametersSchema = Schema.Struct({
  edits: Schema.Array(EditParametersSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(12))
    .annotate({
      description: "All already-read page replacements to commit together, from 1 to 12 pages."
    })
})

export const captureReplayOrigin = (
  origin: WikiCommitOrigin,
  action: "create" | "create-directory" | "edit",
  path: string,
  content: string
): WikiCommitOrigin =>
  origin.kind === "capture"
    ? {
        kind: "capture",
        sessionId: origin.sessionId,
        replayKey: `memory-capture:${sha256Hex(
          JSON.stringify({
            action,
            content_sha256: sha256Hex(content),
            path
          })
        )}`
      }
    : origin

export const wikiFailure = (error: WikiError): ToolExecutionError => {
  switch (error.reason) {
    case "not_found":
      return new ToolExecutionError(
        `${error.message} Call wiki_list_pages and retry with an exact active page path.`,
        { preview: "Wiki page not found", retryable: false }
      )
    case "conflict":
      return new ToolExecutionError(
        "The wiki changed after it was read. Read the relevant page again, then retry.",
        { preview: "Wiki changed", retryable: true }
      )
    case "blocked":
      return new ToolExecutionError(error.message, {
        preview: "Wiki write blocked",
        retryable: false
      })
    case "invalid":
      return new ToolExecutionError(
        `The wiki page path, metadata, or Markdown body is invalid: ${error.message}`,
        { preview: "Invalid wiki page", retryable: false }
      )
    case "closed":
      return new ToolExecutionError("The managed wiki is closed because Arden is shutting down.", {
        preview: "Wiki closed",
        retryable: false
      })
    case "corrupt":
      return new ToolExecutionError(error.message, {
        preview: "Wiki storage failed",
        retryable: false
      })
    case "storage":
      return new ToolExecutionError(error.message, {
        preview: "Wiki storage failed",
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

export const activePages = (snapshot: Snapshot): ReadonlyArray<PageRecord> =>
  snapshot.pages.filter((record) => record.page.lifecycle === "active")

export const activePage = (snapshot: Snapshot, path: string): PageRecord | null => {
  const pages = activePages(snapshot)
  const direct = pages.find((record) => record.resource.path === path)
  if (direct !== undefined) return direct
  const wanted = normal(path)
  return (
    pages.find((record) =>
      pageNamesForPath(record.resource.path).some((name) => normal(name) === wanted)
    ) ?? null
  )
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
  const wanted = new Set(pageNamesForPath(path).map(normal))
  return activePages(snapshot)
    .filter((record) => record.page.aliases.some((alias) => wanted.has(normal(alias))))
    .map((record) => record.resource.path)
}

export const pageNotFound = (snapshot: Snapshot, path: string): ToolExecutionError => {
  const redirected = redirectTargetAt(snapshot, path)
  if (redirected !== null)
    return new ToolExecutionError(
      `'${path}' now redirects to '${redirected.resource.path}'. Use '${redirected.resource.path}' to change that page.`,
      { preview: "Wiki page moved", retryable: false }
    )
  const named = pagesWithPathAlias(snapshot, path).slice(0, 3)
  const hint =
    named.length === 0
      ? "Call wiki_list_pages and retry with an exact active page path."
      : `${named.map((candidate) => `'${candidate}'`).join(", ")} lists '${path}' as an earlier name; read it if it is the page you want.`
  return new ToolExecutionError(`No active wiki page exists at '${path}'. ${hint}`, {
    preview: "Wiki page not found",
    retryable: false
  })
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
          "Wiki directory must be a relative POSIX path without '.' or '..'. Retry with a directory such as 'areas', or empty for the root.",
          { preview: "Invalid wiki directory", retryable: false }
        )
      }
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const entries = listingEntries(activePages(snapshot), directory)
      if (directory !== "" && entries.length === 0) {
        throw new ToolExecutionError(
          `No active wiki directory exists at '${directory}'. List its parent directory, or create the first page under this directory.`,
          { preview: "Wiki directory not found", retryable: false }
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
      "Read the current body of one wiki page by exact path, paginated by line.",
      "Read a page before editing it."
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
        coreBudget === undefined ? chars >= WIKI_PAGE_BUDGET_CHARS : chars > coreBudget
      const isReadme = input.path === "README.md" || input.path.endsWith("/README.md")
      const directory = input.path.slice(0, Math.max(0, input.path.length - "/README.md".length))
      const children = isReadme
        ? listingEntries(activePages(snapshot), directory).filter(
            (entry) => entry.path !== input.path
          )
        : []
      const status = [
        ...(record.resource.path === input.path ||
        pageNamesForPath(record.resource.path).some((name) => normal(name) === normal(input.path))
          ? []
          : [`${input.path} now redirects here, to ${record.resource.path}.`]),
        `page_ref: ${record.page.pageId}`,
        `revision: ${record.resource.versionId}`,
        ...(typeof record.page.metadata["observation_period"] === "string"
          ? [`Observation period: ${record.page.metadata["observation_period"]}`]
          : []),
        ...(typeof record.page.metadata["producer_automation_id"] === "string"
          ? [`Producer Automation: ${record.page.metadata["producer_automation_id"]}`]
          : []),
        ...(Array.isArray(record.page.metadata["source_refs"])
          ? [
              "Original source references:",
              ...record.page.metadata["source_refs"]
                .filter((ref): ref is string => typeof ref === "string")
                .slice(0, 30)
            ]
          : []),
        ...(coreBudget === undefined
          ? []
          : [
              `Page size: ${chars} characters. Every chat receives only the first ${coreBudget} characters of this page (Core Memory).`,
              ...(overBudget
                ? [
                    "The rest never reaches a chat. Bring the whole page within that size: condense wording first, " +
                      "then move project-specific, dated or rarely needed detail to the page that owns it, leaving a short link. " +
                      "Keep every general fact and preference."
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
    name: "wiki_apply_patch_set",
    description: [
      "Commit complete replacements for several already-read Wiki pages as one atomic Memory Capture revision.",
      "Include every page this evidence batch needs to change. The whole set conflicts if any page or the Wiki head changed."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(CapturePatchSetParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Apply Memory Patch Set",
      kind: "tool",
      action: "write",
      approval_preview: "Update several Memory pages together.",
      source: "_wiki",
      changes_state: true,
      target: "reported",
      concurrency_group: "wiki_write",
      destructive: false,
      internal_catalog: true,
      private_scope: "memory_capture"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      if (snapshot.head === null)
        throw new ToolExecutionError(
          "The Wiki has no revision to patch. Create the first required page instead.",
          { preview: "Wiki is empty", retryable: false }
        )
      if (new Set(input.edits.map((edit) => edit.path)).size !== input.edits.length) {
        throw new ToolExecutionError("A Memory patch set cannot repeat a page path.", {
          preview: "Repeated Wiki page",
          retryable: false
        })
      }
      const expectedHead = ctx.run.observations.observedHead()
      if (expectedHead === undefined) {
        throw new ToolExecutionError(
          "Read every target page before applying the Memory patch set.",
          { preview: "Read required", retryable: false }
        )
      }
      const edits = await Promise.all(
        input.edits.map(async (edit) => {
          const record = activePage(snapshot, edit.path)
          if (record === null) throw pageNotFound(snapshot, edit.path)
          const expectedVersion = ctx.run.observations.observed(record.page.pageId)
          if (expectedVersion === undefined) {
            throw new ToolExecutionError(
              `Read ${record.resource.path} before including it in the patch set.`,
              { preview: "Read required", retryable: false }
            )
          }
          if (edit.body !== undefined)
            requireWithinCoreBudget({
              path: record.resource.path,
              pageId: record.page.pageId,
              body: edit.body
            })
          return {
            record,
            expectedVersion,
            content: await Effect.runPromise(reviseWikiPage(record.page, edit), {
              signal: ctx.signal
            })
          }
        })
      )
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      if (!identity.capture || identity.captureBatch === null) {
        throw new ToolExecutionError(
          "Only the built-in Memory Capture worker can apply a Memory patch set.",
          { preview: "Memory Capture required", retryable: false }
        )
      }
      const applied = await Effect.runPromise(
        wiki
          .applyCapturePatchSet({
            edits: edits.map(({ record, expectedVersion, content }) => ({
              pageId: record.page.pageId,
              expectedVersion,
              content
            })),
            expectedHead,
            authority: identity.authority,
            batch: identity.captureBatch,
            commit: {
              actor: identity.actor,
              reason: `capture Memory patch set for ${edits.map(({ record }) => record.resource.path).join(", ")}`
            }
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      if (applied.changed) effects.applied()
      else effects.unchanged()
      const before = new Map(edits.map((edit) => [edit.record.page.pageId, edit.expectedVersion]))
      const receipt = applied.changed
        ? pagesReceipt(
            ctx,
            applied.pages.map((page) => ({
              pageId: page.pageId,
              path: page.path,
              title: page.title,
              beforeVersion: before.get(page.pageId) ?? page.version,
              afterVersion: page.version
            }))
          )
        : undefined
      return {
        ...(receipt === undefined ? {} : { host: receipt }),
        result: applied.changed
          ? `Updated ${applied.pages.map((page) => page.path).join(", ")} in one Memory commit.`
          : "Every page in the Memory patch set was already current.",
        preview: applied.changed ? "Memory pages updated" : "Memory pages unchanged",
        data: {
          pages: applied.pages.map(writtenPageData),
          changed: applied.changed
        }
      }
    }
  }),

  defineServerTool({
    name: "wiki_create_page",
    description: [
      "Create a new wiki page at an exact relative POSIX .md path inside an existing wiki directory.",
      "Read the root and target directory README, search for an existing owner, and supply useful content. Do not create empty placeholders. Fails if the path or page name already exists."
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
          `A wiki page already exists at '${input.path}' with different content. Read the existing page, choose another path, or edit that page instead.`,
          { preview: "Wiki path already exists", retryable: false }
        )
      }
      requireWithinCoreBudget({ path: input.path, pageId: "", body: input.body })
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
                origin: captureReplayOrigin(
                  identity.origin,
                  "create",
                  input.path,
                  `${input.title}\n${input.body}`
                ),
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
      "Replace the Markdown body, aliases and/or observation_period of one existing wiki page.",
      "The page title, identity, producer attribution, source references and other metadata stay unchanged. Read the page first to base the edit on its",
      "current content; the edit fails if the wiki changed since that read.",
      `Aim for ${WIKI_PAGE_BUDGET_CHARS} characters. Condense repetition before splitting;`,
      "create another page only for a distinct subject or useful reading scope, with a contextual link."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EditParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Edit Wiki Page",
      kind: "tool",
      action: "write",
      approval_preview: "Edit one Memory page.",
      source: "_wiki",
      scopes: ["memory_capture"],
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = activePage(snapshot, input.path)
      if (record === null || snapshot.head === null) throw pageNotFound(snapshot, input.path)
      const replacement = await Effect.runPromise(reviseWikiPage(record.page, input), {
        signal: ctx.signal
      })
      if (replacement === record.page.content) {
        ctx.run.observations.observe(record.page.pageId, record.resource.versionId)
        effects.unchanged()
        return {
          result: `${record.resource.path} already has the requested content, aliases and observation period.`,
          preview: "Wiki page unchanged",
          data: { page: pageData(record), changed: false }
        }
      }
      const observedVersion = ctx.run.observations.observed(record.page.pageId)
      if (observedVersion === undefined) {
        throw new ToolExecutionError(
          "Read this wiki page before changing it. Call wiki_read_page for this exact path, then retry the change.",
          { preview: "Read required", retryable: false }
        )
      }
      if (input.body !== undefined)
        requireWithinCoreBudget({
          path: record.resource.path,
          pageId: record.page.pageId,
          body: input.body
        })
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const updated = await recordApplied(
        effects,
        Effect.runPromise(
          wiki
            .update({
              pageId: record.page.pageId,
              content: replacement,
              expectedVersion: observedVersion,
              expectedHead: snapshot.head,
              authority: identity.authority,
              commit: {
                actor: identity.actor,
                origin: captureReplayOrigin(
                  identity.origin,
                  "edit",
                  record.resource.path,
                  replacement
                ),
                reason: `edit wiki page ${record.resource.path}`
              }
            })
            .pipe(Effect.mapError(wikiFailure)),
          { signal: ctx.signal }
        )
      )
      ctx.run.observations.observe(updated.pageId, updated.version)
      return {
        result: `Updated ${updated.path}.`,
        preview: "Wiki page updated",
        data: { page: writtenPageData(updated), changed: true },
        host: pageReceipt({ ctx, page: updated, beforeVersion: observedVersion })
      }
    }
  })
]

export const wikiTools = Effect.gen(function* () {
  return makeWikiTools({ wiki: yield* Wiki, runs: yield* RunQueries })
})
