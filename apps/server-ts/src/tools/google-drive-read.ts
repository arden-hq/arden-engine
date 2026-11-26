import { countOf } from "@arden-hq/std/count"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { Schema } from "effect"

import {
  ListTabsParametersSchema,
  MAX_DOCUMENT_CHARS,
  ReadDocParametersSchema,
  ReadSheetParametersSchema,
  sheetRange
} from "./google-drive-schemas.js"
import { googleCall } from "./google-request.js"
import { passage } from "./source-passage.js"
import { docsDocument, documentTabs, documentText } from "./google-docs-document.js"
import { documentImagesForModel } from "./google-docs-images.js"
import { sha256Base64Url } from "@arden-hq/std/hash"
import { encodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"
import {
  DOCS_API,
  SHEETS_API,
  fileRef,
  parseFileRef,
  readCursor,
  documentUrl,
  spreadsheetUrl
} from "./google-drive-support.js"

export const makeDriveReadTools = ({
  google
}: {
  readonly google: GoogleToolConnections
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "drive_list_doc_tabs",
    summary: "Lists the tabs in a Google Doc.",
    discovery: { group: "drive" },
    description: [
      "List a Google Doc's tab hierarchy and exact tab_id values without returning document text.",
      "Use drive_read_doc with a tab_id to read one tab."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ListTabsParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "List Google Doc Tabs",
      kind: "tool",
      action: "read",
      approval_preview: "List this Google Doc's tabs.",
      source: "google_drive",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      policy_scope: "external",
      permissions: ["google_drive"]
    },
    execute: async (input, ctx) => {
      const ref = parseFileRef(input.document_ref)
      const url = new URL(`${DOCS_API}/${encodeURIComponent(ref.id)}`)
      url.searchParams.set("includeTabsContent", "true")
      const response = await googleCall({
        google,
        service: "google_drive",
        url: url.href,
        accountRef: ref.accountRef,
        signal: ctx.signal
      })
      const document = docsDocument(response.value)
      const tabs = documentTabs(document).map((tab) => ({
        tab_id: tab.id,
        title: tab.title,
        index: tab.index,
        parent_tab_id: tab.parentId,
        depth: tab.depth,
        path: tab.path
      }))
      const source_refs = [
        {
          provider: "drive",
          kind: "doc",
          ref: fileRef(response.account.email, ref.id),
          title: document.title,
          use: "read" as const,
          href: documentUrl(ref.id)
        }
      ]
      return {
        host: { source_refs },
        result: tabs
          .map(
            (tab) => `${"  ".repeat(tab.depth)}• ${tab.path.join(" › ")} — tab_id: ${tab.tab_id}`
          )
          .join("\n"),
        preview: `${countOf(tabs.length, "tab")}`,
        data: {
          document_ref: fileRef(response.account.email, ref.id),
          document_title: document.title,
          tabs,
          source_refs
        }
      }
    }
  }),
  defineServerTool({
    name: "drive_read_doc",
    summary: "Reads a Google Doc.",
    discovery: { group: "drive" },
    description: [
      "Read text from all tabs of a Google Doc, or from one tab chosen with drive_list_doc_tabs.",
      "Returns 20,000 characters per call by default; pass next_cursor to read on. Only the first 200,000 characters can be read.",
      "Each placed image shows as a numbered [Image N] marker where it sits; where the model takes images, the images of the page read are attached after the text."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReadDocParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Read Google Doc",
      kind: "tool",
      action: "read",
      approval_preview: "Read this Google Doc.",
      source: "google_drive",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      policy_scope: "external",
      permissions: ["google_drive"]
    },
    execute: async (input, ctx) => {
      const ref = parseFileRef(input.document_ref)
      const url = new URL(`${DOCS_API}/${encodeURIComponent(ref.id)}`)
      url.searchParams.set("includeTabsContent", "true")
      const response = await googleCall({
        google,
        service: "google_drive",
        url: url.href,
        accountRef: ref.accountRef,
        signal: ctx.signal
      })
      const document = docsDocument(response.value)
      const tabs = documentTabs(document)
      const selected =
        input.tab_id === undefined ? tabs : tabs.filter((tab) => tab.id === input.tab_id)
      if (selected.length === 0)
        throw toolRefusal("The Google Doc tab_id no longer exists.", "Tab not found")
      const read = documentText(selected, { titled: tabs.length > 1 })
      const text = read.text.slice(0, MAX_DOCUMENT_CHARS)
      const digest = sha256Base64Url(text)
      const offset = readCursor(input.cursor, {
        document: ref.id,
        tab: input.tab_id ?? null,
        digest
      })
      if (offset > text.length)
        throw toolRefusal(
          "The Google Doc cursor is past the document end.",
          "Invalid document cursor"
        )
      const end = Math.min(text.length, offset + input.limit)
      const nextCursor =
        end < text.length
          ? encodeOpaque({
              version: 1,
              document: ref.id,
              tab: input.tab_id ?? null,
              digest,
              offset: end
            })
          : null
      const content = text.slice(offset, end)
      const shown = await documentImagesForModel({
        images: read.images.filter((image) => image.start >= offset && image.start < end),
        imageInput: ctx.run.imageInput,
        signal: ctx.signal
      })
      const excerpt = passage(content)
      const source_refs = [
        {
          provider: "drive",
          kind: "doc",
          ref: fileRef(response.account.email, ref.id),
          title: document.title,
          use: "read" as const,
          href: `https://docs.google.com/document/d/${encodeURIComponent(ref.id)}/edit`,
          ...(excerpt === undefined ? {} : { excerpt })
        }
      ]
      return {
        host: { source_refs },
        result: `${content || "(empty document)"}${shown.note === "" ? "" : `\n\n${shown.note}`}${nextCursor === null ? "" : `\n\nNext cursor: ${nextCursor}`}`,
        preview: `${document.title} · ${offset}-${end} of ${text.length}`,
        data: {
          document_ref: fileRef(response.account.email, ref.id),
          document_title: document.title,
          tab_id: input.tab_id ?? null,
          offset,
          end_offset: end,
          total_chars: text.length,
          next_cursor: nextCursor,
          images_attached: shown.content.length,
          source_refs
        },
        ...(shown.content.length === 0 ? {} : { model_content: shown.content })
      }
    }
  }),
  defineServerTool({
    name: "drive_read_sheet",
    summary: "Reads a Google Sheet.",
    discovery: { group: "drive" },
    description: [
      "Read the values in one A1 range of a Google Sheet, such as Sheet1!A1:D50.",
      "Returns every value in the range with no truncation or paging, so keep the range small."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReadSheetParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Read Google Sheet",
      kind: "tool",
      action: "read",
      approval_preview: "Read this Google Sheet range.",
      source: "google_drive",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      policy_scope: "external",
      permissions: ["google_drive"]
    },
    execute: async (input, ctx) => {
      const ref = parseFileRef(input.spreadsheet_ref)
      const url = `${SHEETS_API}/${encodeURIComponent(ref.id)}/values/${encodeURIComponent(input.range)}`
      const response = await googleCall({
        google,
        service: "google_drive",
        url,
        accountRef: ref.accountRef,
        signal: ctx.signal
      })
      const body = sheetRange(response.value)
      const values = body.values ?? []
      const range = body.range ?? input.range
      const source_refs = [
        {
          provider: "drive",
          kind: "sheet",
          ref: fileRef(response.account.email, ref.id),
          title: range,
          use: "read" as const,
          href: spreadsheetUrl(ref.id)
        }
      ]
      return {
        host: { source_refs },
        result: `Range: ${range}\n${values.length === 0 ? "(empty)" : values.map((row) => row.join(" | ")).join("\n")}`,
        preview: `Read ${range}`,
        data: {
          spreadsheet_ref: fileRef(response.account.email, ref.id),
          range,
          values,
          source_refs
        }
      }
    }
  })
]
