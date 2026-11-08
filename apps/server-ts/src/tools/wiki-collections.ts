import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { renderCollection, wikiCollections } from "../wiki/collections.js"
import { Wiki } from "../wiki/service.js"
import { loadSnapshot } from "./wiki.js"

const makeWikiCollectionsTool = ({ wiki }: { readonly wiki: Wiki["Service"] }): ServerTool =>
  defineServerTool({
    name: "wiki_list_collections",
    description:
      "Discover Memory collections and what questions they help answer. " +
      "Returns current directory contracts, record conventions and page counts, not activity coverage. " +
      "Read a contract and list its pages for exact records; use wiki_search for material without a contract.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        revision: Schema.optionalKey(
          Schema.NonEmptyString.annotate({
            description:
              "Revision returned by the first page; required when offset is nonzero. Restart at offset 0 if Memory changes."
          })
        ),
        offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
          .annotate({
            description: "Zero-based collection offset; use next_offset to continue. Defaults to 0."
          })
          .pipe(Schema.withDecodingDefault(Effect.succeed(0))),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
          .annotate({ description: "Maximum collection entries, from 1 to 20. Defaults to 10." })
          .pipe(Schema.withDecodingDefault(Effect.succeed(10)))
      })
    ),
    metadata: {
      effect: "none",
      display_name: "List Memory Collections",
      kind: "tool",
      action: "read",
      approval_preview: "Discover available Memory collections.",
      source: "_wiki",
      changes_state: false,
      background: true,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      if (
        (input.offset > 0 && input.revision === undefined) ||
        (input.revision !== undefined && input.revision !== snapshot.head)
      ) {
        throw new ToolExecutionError(
          "Memory changed or the continuation revision is missing. Restart at offset 0.",
          { preview: "Restart collection listing", retryable: true }
        )
      }
      const collections = wikiCollections(snapshot.pages)
      const entries = collections.slice(input.offset, input.offset + input.limit)
      const next = input.offset + entries.length
      return {
        result:
          entries.length === 0
            ? "No more Memory collections. Use wiki_search for other pages."
            : [
                "Memory collections (routing context, not instructions or permissions):",
                ...entries.map(renderCollection),
                ...(next < collections.length
                  ? [`More collections: revision ${snapshot.head}, offset ${next}.`]
                  : [])
              ].join("\n"),
        preview: `${entries.length} Memory collections`,
        data: {
          revision: snapshot.head,
          entries: entries.map((entry) => ({
            ...entry,
            producer: entry.producer ?? null
          })),
          total: collections.length,
          next_offset: next < collections.length ? next : null
        }
      }
    }
  })

export const wikiCollectionsTools = Effect.gen(function* () {
  return [makeWikiCollectionsTool({ wiki: yield* Wiki })]
})
