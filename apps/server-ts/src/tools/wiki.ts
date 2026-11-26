import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { Array as Arr, Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { writeIdentity } from "./wiki-identity.js"
import { outsideEditNotice } from "../wiki/outside-edits.js"
import { nameKeys, normal, reviseWikiPage } from "../wiki/page.js"
import { loadPageAges, PAGE_AGE_RULE } from "../wiki/page-age.js"
import { Wiki } from "../wiki/service.js"
import { activeRunPages } from "../wiki/snapshot.js"
import { bodyFields } from "./code-mode-result.js"
import { recordApplied } from "../execution/tool-effect.js"
import {
  MAX_PAGE_SOURCES,
  memorySource,
  pageReceipt,
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
import {
  WIKI_PAGE_BUDGET_CHARS,
  EditParametersSchema,
  CreateParametersSchema,
  ReadParametersSchema,
  ListParametersSchema
} from "./wiki-schemas.js"
import {
  loadSnapshot,
  pageNotFound,
  parseDirectory,
  readablePage,
  wikiFailure
} from "./wiki-access.js"
import {
  boundedBody,
  formatListingEntry,
  listingEntries,
  pageData,
  renderListing,
  writtenPageData
} from "./wiki-render.js"
import { changePages, keptPage } from "./wiki-page-writes.js"

const makeWikiTools = ({
  wiki,
  runs
}: {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_list_pages",
    summary: "Lists memory pages.",
    discovery: { group: "wiki_upkeep" },
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
    summary: "Reads a memory page.",
    discovery: "always_loaded",
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
    summary: "Adds a memory page.",
    discovery: { group: "wiki_upkeep" },
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
    summary: "Changes a memory page.",
    discovery: { group: "wiki_upkeep" },
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
        input,
        paths: Arr.map(edits, (edit) => edit.path),
        save: async ({ head, records, writer, run }) => {
          const revised = await Promise.all(
            Arr.map(Arr.zip(edits, records), async ([edit, record]) => ({
              record,
              content: await Effect.runPromise(reviseWikiPage(record.page, edit), {
                signal: ctx.signal
              })
            }))
          )
          const sent = revised.filter(({ record, content }) => content !== record.page.content)
          if (!Arr.isArrayNonEmpty(sent)) return Arr.map(revised, ({ record }) => keptPage(record))
          const sentEdits = Arr.map(sent, ({ record, content }) => ({
            pageId: record.page.pageId,
            content,
            expectedVersion: requireObserved(ctx.run, record)
          }))
          const pages = await run(
            wiki.update({
              edits: sentEdits,
              expectedHead: head,
              ...writer(
                `edit wiki page ${sent.map(({ record }) => record.resource.path).join(", ")}`
              )
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
