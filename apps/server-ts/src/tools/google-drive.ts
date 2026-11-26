import { countOf } from "@arden-hq/std/count"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { Schema } from "effect"

import { connectedAccountEmails } from "./google-accounts.js"
import {
  createParametersSchema,
  DOC_EDIT,
  EditDocParametersSchema,
  searchParametersSchema,
  sheetUpdate,
  SheetWriteParametersSchema
} from "./google-drive-schemas.js"
import { googleCall } from "./google-request.js"
import { DRIVE_FILE_KIND, driveFileKind, SEARCH_MIME_QUERY } from "./google-drive-mime.js"
import { replacedCount } from "./google-docs-document.js"
import { encodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"
import { makeDriveReadTools } from "./google-drive-read.js"
import {
  DRIVE_API,
  DOCS_API,
  SHEETS_API,
  fileList,
  createdDocument,
  createdSpreadsheet,
  fileRef,
  parseFileRef,
  escapeDriveQuery,
  decodePageRef,
  documentUrl,
  spreadsheetUrl,
  MAX_FOUND_SOURCES,
  namedFile
} from "./google-drive-support.js"

type SheetWriteTool = (typeof SHEET_WRITE_TOOL)[keyof typeof SHEET_WRITE_TOOL]

const SheetWriteStandardSchema = Schema.toStandardSchemaV1(SheetWriteParametersSchema)

const SHEET_WRITE_TOOL = {
  update: "drive_update_sheet",
  append: "drive_append_sheet_rows"
} as const

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
      summary: "Searches your Google Drive.",
      discovery: { group: "drive" },
      description: [
        "Search non-trashed files and folders in My Drive and files shared with the user, by name or indexed content, newest modified first.",
        "Shared drives are not searched.",
        "Returns metadata and file_ref values for the Drive read, edit, download and share tools."
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
          .filter(
            (file) =>
              file.kind === DRIVE_FILE_KIND.document || file.kind === DRIVE_FILE_KIND.spreadsheet
          )
          .slice(0, MAX_FOUND_SOURCES)
          .map((file) => ({
            provider: "drive",
            kind: file.kind === DRIVE_FILE_KIND.document ? "doc" : "sheet",
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
    ...makeDriveReadTools({ google }),
    defineServerTool({
      name: "drive_create_doc",
      summary: "Creates a Google Doc.",
      discovery: { group: "drive" },
      description: [
        "Create an empty Google Doc in the root of My Drive for an explicit connected account.",
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
        concurrency_group: "drive_write",
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
      summary: "Changes a Google Doc.",
      discovery: { group: "drive" },
      description: [
        "Append text at the end of a Google Doc's first tab, or replace every exact case-sensitive match of text in all tabs.",
        "A replace that matches nothing changes nothing and fails. Asks by default; replace is destructive."
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
        concurrency_group: "drive_write",
        destructive: true,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["google_drive"],
        idempotent: false,
        target: "reported"
      },
      execute: async (input, ctx, effects) => {
        const ref = parseFileRef(input.document_ref)
        if (input.operation === DOC_EDIT.replace && input.match === undefined) {
          throw toolRefusal("match is required for replace operations.", "Missing match text")
        }
        if (input.operation === DOC_EDIT.append && input.match !== undefined) {
          throw toolRefusal("match is only valid for replace operations.", "Unexpected match text")
        }
        const request =
          input.operation === DOC_EDIT.append
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
        const response = await googleCall({
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
        const replaced =
          input.operation === DOC_EDIT.replace ? replacedCount(response.value) : undefined
        if (replaced === 0)
          throw toolRefusal(
            "No exact case-sensitive match for match text in the Google Doc. Nothing changed.",
            "No match found"
          )
        return {
          result:
            replaced === undefined
              ? `Appended text to Google Doc ${input.document_ref}.`
              : `Replaced ${countOf(replaced, "match", "matches")} in Google Doc ${input.document_ref}.`,
          preview:
            replaced === undefined
              ? "Text appended"
              : `${countOf(replaced, "match", "matches")} replaced`,
          data: {
            document_ref: input.document_ref,
            operation: input.operation,
            ...(replaced === undefined ? {} : { occurrences_changed: replaced })
          }
        }
      }
    }),
    defineServerTool({
      name: "drive_create_sheet",
      summary: "Creates a Google Sheet.",
      discovery: { group: "drive" },
      description: [
        "Create an empty Google Sheet in the root of My Drive for an explicit connected account.",
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
        concurrency_group: "drive_write",
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
    ...Object.values(SHEET_WRITE_TOOL).map((name: SheetWriteTool) =>
      defineServerTool<typeof SheetWriteStandardSchema>({
        name,
        summary:
          name === SHEET_WRITE_TOOL.update
            ? "Writes values into part of a Google Sheet."
            : "Adds rows to the end of a table in a Google Sheet.",
        discovery: { group: "drive" },
        description:
          name === SHEET_WRITE_TOOL.update
            ? "Write a row-major value matrix to an exact Google Sheet A1 range. Use drive_append_sheet_rows to add after an existing table. Asks by default."
            : "Append row-major values after the table found within a Google Sheet A1 range, inserting rows as needed. Use drive_update_sheet for an exact target range. Asks by default.",
        parameters: SheetWriteStandardSchema,
        metadata: {
          effect: "external",
          display_name:
            name === SHEET_WRITE_TOOL.update ? "Update Google Sheet" : "Append Google Sheet Rows",
          kind: "tool",
          action: "write",
          approval_preview:
            name === SHEET_WRITE_TOOL.update
              ? "Update this Google Sheet range."
              : "Append rows to this Google Sheet.",
          source: "google_drive",
          changes_state: true,
          concurrency_group: "drive_write",
          destructive: name === SHEET_WRITE_TOOL.update,
          default_approval: "ask",
          policy_scope: "external",
          permissions: ["google_drive"],
          idempotent: false,
          target: "reported"
        },
        execute: async (input, ctx, effects) => {
          const ref = parseFileRef(input.spreadsheet_ref)
          const suffix =
            name === SHEET_WRITE_TOOL.update
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
              method: name === SHEET_WRITE_TOOL.update ? "PUT" : "POST",
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
          const written = body.updatedRange ?? body.updates?.updatedRange ?? input.range
          return {
            result: `${name === SHEET_WRITE_TOOL.update ? "Updated" : "Appended rows to"} ${written}.`,
            preview: name === SHEET_WRITE_TOOL.update ? "Sheet updated" : "Rows appended",
            data: {
              spreadsheet_ref: fileRef(response.account.email, ref.id),
              range: written
            }
          }
        }
      })
    )
  ]
}
