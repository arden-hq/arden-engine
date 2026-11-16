import { Schema } from "effect"
import { RunQueries } from "../persistence/runs/queries.js"
import type { Wiki } from "../wiki/service.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { WikiPathSchema, changePages, writtenPageData } from "./wiki.js"
import { requireObserved } from "./wiki-records.js"
const ActiveWikiPathSchema = WikiPathSchema.annotate({
  description: "Exact relative POSIX .md path of an active page returned by Wiki search or listing."
})

const ArchiveParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema
})

const MergeParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema.annotate({
    description: "Exact path of the page to retire. Its content must already be in `into`."
  }),
  into: ActiveWikiPathSchema.annotate({
    description:
      "Exact path of the active page that now holds the content. The retired path redirects there, so links to it keep working."
  })
})

/**
 * The two ways a page leaves the Wiki. Merging keeps its path opening the page that replaced
 * it; archiving is for a page nothing replaces.
 */
export const makeWikiRetireTools = ({
  wiki,
  runs
}: {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_archive_page",
    description:
      "Recoverably archive one active Wiki page that no other page replaces. Read it first; revision history is retained. When another page now holds its content, use wiki_merge_page instead, so links keep working. Asks by default.",
    parameters: Schema.toStandardSchemaV1(ArchiveParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Archive Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Archive one Memory page.",
      source: "_wiki",
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const {
        saved: [{ page: archived }],
        receipt
      } = await changePages({ wiki, runs }, ctx, effects, {
        paths: [input.path],
        save: async ({ head, records: [record], writer, run }) => {
          const expectedVersion = requireObserved(ctx.run, record)
          const archived = await run(
            wiki.archive({
              pageId: record.page.pageId,
              expectedVersion,
              expectedHead: head,
              ...writer(`archive wiki page ${record.resource.path}`)
            })
          )
          return [{ page: { ...archived, title: record.page.title }, before: expectedVersion }]
        }
      })
      return {
        result: `Archived ${archived.path}.`,
        preview: "Wiki page archived",
        data: { page: archived, changed: true },
        ...(receipt === undefined ? {} : { host: receipt })
      }
    }
  }),
  defineServerTool({
    name: "wiki_merge_page",
    description:
      "Retire one active Wiki page whose content another page now holds. Read both pages first and move anything unique into the other page before merging. The retired path redirects to the other page, so links keep working, and wiki_restore_page can bring the page back. Asks by default, except in Memory runs.",
    parameters: Schema.toStandardSchemaV1(MergeParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Merge Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Merge one Memory page into another.",
      source: "_wiki",
      scopes: ["memory_capture"],
      unattended_scope: "memory_capture",
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const {
        records: [record, target],
        receipt
      } = await changePages({ wiki, runs }, ctx, effects, {
        paths: [input.path, input.into],
        save: async ({ head, records: [record, target], writer, run }) => {
          const expectedVersion = requireObserved(ctx.run, record)
          requireObserved(ctx.run, target)
          await run(
            wiki.mergeInto({
              pageId: record.page.pageId,
              targetPageId: target.page.pageId,
              expectedVersion,
              expectedHead: head,
              ...writer(`merge wiki page ${record.resource.path} into ${target.resource.path}`)
            })
          )
          return [{ page: await run(wiki.read(record.page.pageId)), before: expectedVersion }]
        }
      })
      return {
        result: `Archived ${record.resource.path}; its path now redirects to ${target.resource.path}.`,
        preview: "Wiki page merged",
        data: {
          page: writtenPageData({ ...target.page, path: target.resource.path }),
          merged_from: record.resource.path,
          changed: true
        },
        ...(receipt === undefined ? {} : { host: receipt })
      }
    }
  })
]
