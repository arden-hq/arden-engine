import { countOf } from "@arden-hq/std/count"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { Option, Schema } from "effect"

import { connectedAccountEmails } from "./google-accounts.js"
import {
  createParametersSchema,
  EditDocParametersSchema,
  ListTabsParametersSchema,
  MAX_DOCUMENT_CHARS,
  ReadDocParametersSchema,
  ReadSheetParametersSchema,
  searchParametersSchema,
  SheetWriteParametersSchema
} from "./google-drive-schemas.js"
import type { EffectTarget } from "../execution/tool-effect.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { passage } from "./source-passage.js"
import { docsDocument, documentTabs, documentText } from "./google-docs-document.js"
import { documentImagesForModel } from "./google-docs-images.js"
import { sha256Base64Url } from "@arden-hq/std/hash"
import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"

const SheetWriteStandardSchema = Schema.toStandardSchemaV1(SheetWriteParametersSchema)

const DRIVE_API = "https://www.googleapis.com/drive/v3/files"
const DOCS_API = "https://docs.googleapis.com/v1/documents"
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
const DOC_MIME = "application/vnd.google-apps.document"
const SHEET_MIME = "application/vnd.google-apps.spreadsheet"
const SEARCH_MIME_QUERY = {
  any: "",
  document: `mimeType='${DOC_MIME}'`,
  spreadsheet: `mimeType='${SHEET_MIME}'`
} as const

const driveFileKind = (mimeType: string): string => {
  switch (mimeType) {
    case DOC_MIME:
      return "document"
    case SHEET_MIME:
      return "spreadsheet"
    case "application/vnd.google-apps.folder":
      return "folder"
    case "application/vnd.google-apps.presentation":
      return "presentation"
    default:
      return "file"
  }
}

const DriveFileSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
  size: Schema.optionalKey(Schema.String),
  modifiedTime: Schema.optionalKey(Schema.String),
  webViewLink: Schema.optionalKey(Schema.String)
})

const fileList = decodeGoogle(
  Schema.Struct({
    files: Schema.optionalKey(Schema.Array(DriveFileSchema)),
    nextPageToken: Schema.optionalKey(Schema.String),
    incompleteSearch: Schema.optionalKey(Schema.Boolean)
  }),
  { service: "google_drive", label: "file list" }
)

const sheetRange = decodeGoogle(
  Schema.Struct({
    range: Schema.optionalKey(Schema.String),
    values: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Unknown)))
  }),
  { service: "google_drive", label: "sheet range" }
)

const createdDocument = decodeGoogle(
  Schema.Struct({ documentId: Schema.NonEmptyString, title: Schema.optionalKey(Schema.String) }),
  { service: "google_drive", label: "document" }
)

const createdSpreadsheet = decodeGoogle(
  Schema.Struct({
    spreadsheetId: Schema.NonEmptyString,
    spreadsheetUrl: Schema.optionalKey(Schema.String),
    properties: Schema.optionalKey(Schema.Struct({ title: Schema.optionalKey(Schema.String) }))
  }),
  { service: "google_drive", label: "spreadsheet" }
)

/** `values.update` answers with `updatedRange`; `values.append` nests it under `updates`. */
const sheetUpdate = decodeGoogle(
  Schema.Struct({
    updatedRange: Schema.optionalKey(Schema.String),
    updates: Schema.optionalKey(Schema.Struct({ updatedRange: Schema.optionalKey(Schema.String) }))
  }),
  { service: "google_drive", label: "sheet update" }
)

const DrivePageRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  fingerprint: Schema.String,
  token: Schema.String,
  account: Schema.String
})

const DocumentCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  document: Schema.String,
  tab: Schema.NullOr(Schema.String),
  digest: Schema.String,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const fileRef = (account: string, id: string): string => `${account}:${id}`

const rawGoogleFileId = (value: string): string | undefined => {
  const match = value.match(
    /^https:\/\/(?:docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/|drive\.google\.com\/file\/d\/)([A-Za-z0-9_-]+)(?:[/?#]|$)/u
  )
  if (match !== null) return match[1]
  return /^[A-Za-z0-9_-]{8,512}$/u.test(value) ? value : undefined
}

export const parseFileRef = (
  value: string
): { readonly accountRef?: string; readonly id: string } => {
  const rawId = rawGoogleFileId(value)
  if (rawId !== undefined) return { id: rawId }
  const separator = value.lastIndexOf(":")
  const accountRef = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (separator < 1 || !accountRef.includes("@") || !/^[A-Za-z0-9_-]{8,512}$/u.test(id)) {
    throw toolRefusal(
      "Use a Google Drive file URL or an exact file_ref returned by Drive tools.",
      "Invalid Drive reference"
    )
  }
  return { accountRef, id }
}

const escapeDriveQuery = (value: string): string =>
  value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")

const decodePageRef = (
  value: string | undefined,
  fingerprint: string,
  accountRef: string | undefined
): { readonly token?: string; readonly accountRef?: string } => {
  if (value === undefined) return accountRef === undefined ? {} : { accountRef }
  const decoded = Option.getOrUndefined(decodeOpaque(DrivePageRefSchema, value))
  if (
    decoded === undefined ||
    decoded.fingerprint !== fingerprint ||
    (accountRef !== undefined && accountRef !== decoded.account)
  )
    throw toolRefusal(
      "The Drive page_ref is invalid or belongs to another search.",
      "Invalid page reference"
    )
  return { token: decoded.token, accountRef: decoded.account }
}

const readCursor = (
  value: string | undefined,
  expected: { readonly document: string; readonly tab: string | null; readonly digest: string }
): number => {
  if (value === undefined) return 0
  const cursor = Option.getOrUndefined(decodeOpaque(DocumentCursorSchema, value))
  if (
    cursor === undefined ||
    cursor.document !== expected.document ||
    cursor.tab !== expected.tab ||
    cursor.digest !== expected.digest
  )
    throw toolRefusal("The Google Doc cursor is invalid for this read.", "Invalid document cursor")
  return cursor.offset
}

const documentUrl = (id: string): string =>
  `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`
const spreadsheetUrl = (id: string): string =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`

const MAX_FOUND_SOURCES = 50

const fileName = decodeGoogle(
  Schema.Struct({ name: Schema.NonEmptyString, webViewLink: Schema.optionalKey(Schema.String) }),
  { service: "google_drive", label: "file" }
)

const namedFile = async ({
  google,
  ref,
  link,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly ref: { readonly accountRef?: string; readonly id: string }
  readonly link: (id: string) => string
  readonly signal: AbortSignal
}): Promise<EffectTarget> => {
  const url = new URL(`${DRIVE_API}/${encodeURIComponent(ref.id)}`)
  url.searchParams.set("fields", "name,webViewLink")
  const file = await googleCall({
    google,
    service: "google_drive",
    url: url.href,
    accountRef: ref.accountRef,
    signal
  })
    .then((response) => fileName(response.value))
    .catch(() => undefined)
  return {
    source: "google_drive",
    objectId: ref.id,
    ...(file === undefined ? {} : { title: file.name }),
    href: file?.webViewLink ?? link(ref.id)
  }
}

export const makeDriveTools = ({
  google
}: {
  readonly google: GoogleToolConnections
}): ReadonlyArray<ServerTool> => {
  const emails = connectedAccountEmails(google, "google_drive")
  const SearchParametersSchema = searchParametersSchema(emails)
  const CreateParametersSchema = createParametersSchema(emails)
  return [
    defineServerTool({
      name: "drive_search",
      description: [
        "Search non-trashed Google Drive files and folders by name or indexed content, newest modified first.",
        "Returns metadata and account-qualified refs. Use drive_download to download content explicitly."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(SearchParametersSchema),
      metadata: {
        effect: "none",
        background: true,
        display_name: "Search Google Drive",
        kind: "tool",
        action: "read",
        approval_preview: "Search connected Google Drive accounts.",
        source: "google_drive",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        policy_scope: "external",
        permissions: ["google_drive"]
      },
      execute: async (input, ctx) => {
        const fingerprint = JSON.stringify({
          query: input.query,
          kind: input.kind,
          limit: input.limit
        })
        const page = decodePageRef(input.page_ref, fingerprint, input.account_ref)
        const mimeQuery = SEARCH_MIME_QUERY[input.kind]
        const textQuery =
          input.query === ""
            ? ""
            : ` and (name contains '${escapeDriveQuery(input.query)}' or fullText contains '${escapeDriveQuery(input.query)}')`
        const url = new URL(DRIVE_API)
        url.searchParams.set(
          "q",
          `trashed=false${mimeQuery === "" ? "" : ` and ${mimeQuery}`}${textQuery}`
        )
        url.searchParams.set("spaces", "drive")
        url.searchParams.set("orderBy", "modifiedTime desc")
        url.searchParams.set("pageSize", String(input.limit))
        url.searchParams.set(
          "fields",
          "nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)"
        )
        if (page.token !== undefined) url.searchParams.set("pageToken", page.token)
        const response = await googleCall({
          google,
          service: "google_drive",
          url: url.href,
          accountRef: page.accountRef,
          signal: ctx.signal
        })
        const body = fileList(response.value)
        const files = (body.files ?? []).map((file) => ({
          file_ref: fileRef(response.account.email, file.id),
          name: file.name,
          kind: driveFileKind(file.mimeType),
          mime_type: file.mimeType,
          byte_length: file.size ?? null,
          modified_at: file.modifiedTime ?? null,
          url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`
        }))
        const nextPageRef =
          body.nextPageToken === undefined
            ? null
            : encodeOpaque({
                version: 1,
                fingerprint,
                account: response.account.email,
                token: body.nextPageToken
              })
        const lines =
          files.length === 0
            ? ["No matching Google Drive files."]
            : files.map((file) => `[${file.file_ref}] ${file.name} (${file.kind})`)
        if (nextPageRef !== null) lines.push(`Next page_ref: ${nextPageRef}`)
        if (body.incompleteSearch === true) lines.push("Google reported an incomplete search.")
        const source_refs = files
          .filter((file) => file.kind === "document" || file.kind === "spreadsheet")
          .slice(0, MAX_FOUND_SOURCES)
          .map((file) => ({
            provider: "drive",
            kind: file.kind === "document" ? "doc" : "sheet",
            ref: file.file_ref,
            title: file.name,
            use: "found" as const,
            href: file.url,
            ...(file.modified_at === null ? {} : { at: file.modified_at })
          }))
        return {
          host: { source_refs },
          result: lines.join("\n"),
          preview: `${countOf(files.length, "file")}`,
          data: {
            account_ref: response.account.email,
            files,
            next_page_ref: nextPageRef,
            incomplete_search: body.incompleteSearch === true,
            source_refs
          }
        }
      }
    }),
    defineServerTool({
      name: "drive_list_doc_tabs",
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
      description: [
        "Read up to the first 200,000 characters from all tabs of a Google Doc or one tab selected with drive_list_doc_tabs.",
        "Each placed image shows as a numbered [Image N] marker where it sits; where the model takes images, the images of the page read are attached after the text.",
        "Returns a stable next_cursor for bounded pages."
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
          limits: ctx.run.imageInput,
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
      description: [
        "Read values from one bounded A1 range in a Google Sheet; this tool does not paginate.",
        "Request a narrower range when the result would be large."
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
        // The values API answers without the spreadsheet's name: the range read names it.
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
    }),
    defineServerTool({
      name: "drive_create_doc",
      description: [
        "Create an empty Google Doc in an explicit connected Drive account.",
        "Use drive_edit_doc afterward to add content. Asks by default."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(CreateParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Create Google Doc",
        kind: "tool",
        action: "write",
        approval_preview: "Create this Google Doc.",
        source: "google_drive",
        changes_state: true,
        concurrency_group: "google_drive_write",
        destructive: false,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["google_drive"],
        idempotent: false,
        target: "reported"
      },
      execute: async (input, ctx, effects) => {
        const response = await googleCall({
          google,
          service: "google_drive",
          url: DOCS_API,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: input.title })
          },
          accountRef: input.account_ref,
          signal: ctx.signal,
          effects
        })
        const document = createdDocument(response.value)
        const id = document.documentId
        await effects.created({
          source: "google_drive",
          objectId: id,
          title: document.title ?? input.title,
          href: documentUrl(id)
        })
        return {
          result: `Created ${input.title}: ${documentUrl(id)}\nReference: ${fileRef(response.account.email, id)}`,
          preview: `Created ${input.title}`,
          data: { document_ref: fileRef(response.account.email, id), url: documentUrl(id) }
        }
      }
    }),
    defineServerTool({
      name: "drive_edit_doc",
      description: [
        "Append text at a Google Doc's end or replace every exact case-sensitive text match.",
        "Asks by default; replace is destructive."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(EditDocParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Edit Google Doc",
        kind: "tool",
        action: "write",
        approval_preview: "Edit this Google Doc.",
        source: "google_drive",
        changes_state: true,
        concurrency_group: "google_drive_write",
        destructive: true,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["google_drive"],
        idempotent: false,
        target: "reported"
      },
      execute: async (input, ctx, effects) => {
        const ref = parseFileRef(input.document_ref)
        if (input.operation === "replace" && input.match === undefined) {
          throw toolRefusal("match is required for replace operations.", "Missing match text")
        }
        if (input.operation === "append" && input.match !== undefined) {
          throw toolRefusal("match is only valid for replace operations.", "Unexpected match text")
        }
        const request =
          input.operation === "append"
            ? { insertText: { text: input.text, endOfSegmentLocation: {} } }
            : {
                replaceAllText: {
                  containsText: { text: input.match, matchCase: true },
                  replaceText: input.text
                }
              }
        await effects.target(
          await namedFile({ google, ref, link: documentUrl, signal: ctx.signal })
        )
        await googleCall({
          google,
          service: "google_drive",
          url: `${DOCS_API}/${encodeURIComponent(ref.id)}:batchUpdate`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requests: [request] })
          },
          accountRef: ref.accountRef,
          signal: ctx.signal,
          effects
        })
        return {
          result: `Updated Google Doc ${input.document_ref}.`,
          preview: "Google Doc updated",
          data: { document_ref: input.document_ref, operation: input.operation }
        }
      }
    }),
    defineServerTool({
      name: "drive_create_sheet",
      description: [
        "Create an empty Google Sheet in an explicit connected Drive account.",
        "Use drive_update_sheet or drive_append_sheet_rows afterward. Asks by default."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(CreateParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Create Google Sheet",
        kind: "tool",
        action: "write",
        approval_preview: "Create this Google Sheet.",
        source: "google_drive",
        changes_state: true,
        concurrency_group: "google_drive_write",
        destructive: false,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["google_drive"],
        idempotent: false,
        target: "reported"
      },
      execute: async (input, ctx, effects) => {
        const response = await googleCall({
          google,
          service: "google_drive",
          url: SHEETS_API,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ properties: { title: input.title } })
          },
          accountRef: input.account_ref,
          signal: ctx.signal,
          effects
        })
        const sheet = createdSpreadsheet(response.value)
        const id = sheet.spreadsheetId
        const url = sheet.spreadsheetUrl ?? spreadsheetUrl(id)
        await effects.created({
          source: "google_drive",
          objectId: id,
          title: sheet.properties?.title ?? input.title,
          href: url
        })
        return {
          result: `Created ${input.title}: ${url}\nReference: ${fileRef(response.account.email, id)}`,
          preview: `Created ${input.title}`,
          data: { spreadsheet_ref: fileRef(response.account.email, id), url }
        }
      }
    }),
    ...(["drive_update_sheet", "drive_append_sheet_rows"] as const).map((name) =>
      defineServerTool<typeof SheetWriteStandardSchema>({
        name,
        description:
          name === "drive_update_sheet"
            ? "Write a row-major value matrix to an exact Google Sheet A1 range. Use drive_append_sheet_rows to add after an existing table. Asks by default."
            : "Append row-major values after the table found within a Google Sheet A1 range, inserting rows as needed. Use drive_update_sheet for an exact target range. Asks by default.",
        parameters: SheetWriteStandardSchema,
        metadata: {
          effect: "external",
          display_name:
            name === "drive_update_sheet" ? "Update Google Sheet" : "Append Google Sheet Rows",
          kind: "tool",
          action: "write",
          approval_preview:
            name === "drive_update_sheet"
              ? "Update this Google Sheet range."
              : "Append rows to this Google Sheet.",
          source: "google_drive",
          changes_state: true,
          concurrency_group: "google_drive_write",
          destructive: name === "drive_update_sheet",
          default_approval: "ask",
          policy_scope: "external",
          permissions: ["google_drive"],
          idempotent: false,
          target: "reported"
        },
        execute: async (input, ctx, effects) => {
          const ref = parseFileRef(input.spreadsheet_ref)
          const suffix =
            name === "drive_update_sheet"
              ? `/values/${encodeURIComponent(input.range)}?valueInputOption=${input.value_input_option}`
              : `/values/${encodeURIComponent(input.range)}:append?valueInputOption=${input.value_input_option}&insertDataOption=INSERT_ROWS`
          await effects.target(
            await namedFile({ google, ref, link: spreadsheetUrl, signal: ctx.signal })
          )
          const response = await googleCall({
            google,
            service: "google_drive",
            url: `${SHEETS_API}/${encodeURIComponent(ref.id)}${suffix}`,
            init: {
              method: name === "drive_update_sheet" ? "PUT" : "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                range: input.range,
                majorDimension: "ROWS",
                values: input.values
              })
            },
            accountRef: ref.accountRef,
            signal: ctx.signal,
            effects
          })
          const body = sheetUpdate(response.value)
          return {
            result: `${name === "drive_update_sheet" ? "Updated" : "Appended rows to"} ${input.range}.`,
            preview: name === "drive_update_sheet" ? "Sheet updated" : "Rows appended",
            data: {
              spreadsheet_ref: fileRef(response.account.email, ref.id),
              range: body.updatedRange ?? body.updates?.updatedRange ?? input.range
            }
          }
        }
      })
    )
  ]
}
