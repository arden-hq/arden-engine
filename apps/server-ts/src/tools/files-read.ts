import { countOf, formatBytes } from "@arden-hq/std/count"
import { Schema } from "effect"
import { lstat, readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { ManagedOutputWriter } from "../artifacts/managed-output/managed-output.js"
import { isManagedObjectRef } from "../persistence/managed-output/object-store.js"
import { neverFoldersWithin, type LocalPathServices } from "../storage/local-paths.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { cwdFor, displayFor, filesystemError, resolveFor } from "./file-tool-support.js"
import {
  binaryRefusal,
  FILE_KIND,
  fileKind,
  imageConversionRefusal,
  imageForModel,
  imageNote,
  imageRefusal,
  PDF_TEXT,
  pdfRefusal,
  readPdfText
} from "./read-binary.js"
import {
  ripgrepFind,
  ripgrepSearchContent,
  ripgrepSearchCounts,
  ripgrepSearchFiles
} from "./ripgrep.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolRefusal } from "./tool-failure.js"
import {
  FindParametersSchema,
  ListParametersSchema,
  MAX_DISCOVERY_ENTRIES,
  MAX_READ_BYTES,
  ReadParametersSchema,
  SEARCH_OUTPUT_MODE,
  SearchParametersSchema
} from "./files-read-parameters.js"
import {
  MAX_FOUND_SOURCES,
  UNREADABLE_NOTE,
  decodeCursor,
  encodeCursor,
  entryKind,
  foundSource,
  offerPage,
  renderRead,
  renderSearchRecord
} from "./files-read-render.js"

export const fileReadTools = ({
  outputs,
  ...services
}: LocalPathServices & {
  readonly outputs: ManagedOutputWriter
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "file_read",
    summary: "Reads a file on your Mac or one Arden made.",
    discovery: "always_loaded",
    description: [
      "Read a known UTF-8 file with compact 1-based line numbers (number|text) by default; set line_numbers=false for plain text. Partial reads include the next 1-based offset when more content remains. To find something in a large file, set grep (a regular expression) instead of reading it all: it searches the whole file (offset, limit and line_numbers are ignored) and returns only the matching lines with grep_context lines around them.",
      "A PDF reads as its text, with a [Page N of M] line before each page, paged by the same offset and limit. A PNG, JPEG, GIF, WebP or HEIC image is shown to you as an image when this model takes images. Other binary files (Word, Excel, ZIP and the like) are refused; convert them with exec_command.",
      "Files over 64 MiB are refused. Read a managed-output reference shown in a tool result through path; it must belong to this chat. Saved artifacts (file-... or viz-... refs) cannot be read here; copy one out with artifact_export first. Relative file paths use the current Local folder. Use file_find for names or file_search_text for content discovery. Line-number prefixes are not file content; omit them from edit/write inputs."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReadParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      local_target: { arg: "path", kind: "file" },
      display_name: "Read File",
      kind: "filesystem",
      action: "read",
      approval_preview: "Read a file on your Mac or one Arden made.",
      source: "_filesystem",
      changes_state: false,
      concurrency_group: "filesystem",
      destructive: null
    },
    execute: async (input, ctx) => {
      if (isManagedObjectRef(input.path)) {
        const text = await outputs
          .read({ sessionId: ctx.run.sessionId, ref: input.path })
          .catch(() => {
            throw toolRefusal(
              "Managed output bytes are unavailable or not owned by this Session.",
              "Managed output unavailable"
            )
          })
        const rendered = renderRead(text, input)
        offerPage(ctx, text, input)
        return {
          result: rendered.result,
          preview: rendered.preview,
          data: {
            path: input.path,
            bytes: Buffer.byteLength(text, "utf8"),
            total_lines: rendered.total_lines,
            has_more: rendered.has_more,
            ...(rendered.matches === undefined ? {} : { matches: rendered.matches })
          }
        }
      }
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path)
      try {
        const info = await stat(target)
        if (!info.isFile()) throw toolRefusal(`${target} is not a file.`, "Not a file")
        if (info.size > MAX_READ_BYTES) {
          throw toolRefusal(
            `File is larger than ${formatBytes(MAX_READ_BYTES)}. Read a smaller file or use exec_command with a bounded command.`,
            "File too large"
          )
        }
        const bytes = await readFile(target)
        const name = path.basename(target)
        const source_refs = [
          {
            provider: "file",
            kind: "file",
            ref: target,
            title: name,
            use: "read" as const,
            href: pathToFileURL(target).href,
            at: info.mtime.toISOString()
          }
        ]
        const kind = fileKind({ bytes, name })
        if (kind.kind === FILE_KIND.binary) {
          throw toolRefusal(binaryRefusal(name, kind.label), "Not a text file")
        }
        if (kind.kind === FILE_KIND.image) {
          const imageInput = ctx.run.imageInput
          if (imageInput === undefined) {
            throw toolRefusal(imageRefusal(name, kind.format), "Images not supported")
          }
          const image = await imageForModel({
            file: target,
            bytes,
            format: kind.format,
            limits: imageInput.limits,
            signal: ctx.signal
          })
          if (image === undefined) {
            throw toolRefusal(imageConversionRefusal(name, kind.format), "Image not converted")
          }
          return {
            host: { source_refs },
            result: imageNote(name, kind.format, image),
            preview: `Read ${image.source.width}x${image.source.height} image`,
            data: {
              source_refs,
              path: displayFor(cwd, target),
              absolute_path: target,
              bytes: info.size,
              media_type: image.mediaType,
              width: image.source.width,
              height: image.source.height
            },
            model_content: [
              { type: "image", media_type: image.mediaType, data: image.data.toString("base64") }
            ]
          }
        }
        const pdf = kind.kind === FILE_KIND.pdf ? await readPdfText(bytes) : undefined
        if (pdf !== undefined && pdf.kind !== PDF_TEXT.text) {
          throw toolRefusal(
            pdfRefusal(name, pdf, ctx.run.imageInput !== undefined),
            pdf.kind === PDF_TEXT.noText ? "PDF has no text" : "PDF not readable"
          )
        }
        const source = pdf === undefined ? bytes.toString("utf8") : pdf.text
        const rendered = renderRead(source, input)
        offerPage(ctx, source, input)
        return {
          host: { source_refs },
          result: rendered.result,
          preview: rendered.preview,
          data: {
            source_refs,
            path: displayFor(cwd, target),
            absolute_path: target,
            bytes: info.size,
            ...(pdf === undefined ? {} : { pdf_pages: pdf.pages }),
            total_lines: rendered.total_lines,
            has_more: rendered.has_more,
            ...(rendered.matches === undefined ? {} : { matches: rendered.matches })
          }
        }
      } catch (cause) {
        throw filesystemError(cause, "read", target)
      }
    }
  }),

  defineServerTool({
    name: "file_list",
    summary: "Lists what is in a folder.",
    discovery: "always_loaded",
    description: [
      "List one directory's immediate children with type, size, and modification time. A symbolic link shows kind other and its target's size. Folders the owner's rules hide are left out of the list and the total.",
      "Continue with next_cursor and the same path/include_hidden values; use file_find for recursive discovery."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ListParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "List Files",
      kind: "filesystem",
      action: "read",
      approval_preview: "List a local directory.",
      source: "_filesystem",
      changes_state: false,
      concurrency_group: "filesystem",
      destructive: null
    },
    execute: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const root = await resolveFor(cwd, input.path)
      try {
        if (!(await stat(root)).isDirectory())
          throw toolRefusal(`${root} is not a directory.`, "Not a directory")
        const hidden = new Set(neverFoldersWithin(cwd, root).map((name) => name.toLowerCase()))
        const entries = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => input.include_hidden || !entry.name.startsWith("."))
          .filter((entry) => !hidden.has(entry.name.toLowerCase()))
          .sort((left, right) => {
            const leftRank = left.isDirectory() ? 0 : 1
            const rightRank = right.isDirectory() ? 0 : 1
            return leftRank - rightRank || left.name.localeCompare(right.name)
          })
        const fingerprint = sha256Hex(`${root}\0${input.include_hidden}`)
        const offset = decodeCursor(input.cursor, fingerprint)
        const visible = entries.slice(offset, offset + input.limit)
        const items = await Promise.all(
          visible.map(async (entry) => {
            const absolute = path.join(root, entry.name)
            const info = await stat(absolute).catch(() => lstat(absolute))
            return {
              name: `${entry.name}${entry.isDirectory() ? "/" : ""}`,
              path: displayFor(cwd, absolute),
              absolute_path: absolute,
              kind: entryKind(entry),
              size: info.size,
              modified_at: info.mtime.toISOString()
            }
          })
        )
        const nextOffset = offset + items.length
        const hasMore = nextOffset < entries.length
        const lines = items.map(
          (item) =>
            `${item.name.padEnd(48)} ${formatBytes(item.size).padEnd(9)} ${item.modified_at}`
        )
        if (hasMore) lines.push("More entries are available; continue with next_cursor.")
        const source_refs = items.slice(0, MAX_FOUND_SOURCES).map((item) => ({
          ...foundSource(item.absolute_path, item.name),
          kind: item.kind,
          at: item.modified_at
        }))
        return {
          host: { source_refs },
          result: `${displayFor(cwd, root)} (${entries.length} entries)\n${lines.join("\n") || "(empty)"}`,
          preview: `${items.length} of ${entries.length} entries`,
          data: {
            source_refs,
            path: displayFor(cwd, root),
            absolute_path: root,
            items,
            total: entries.length,
            has_more: hasMore,
            next_cursor: hasMore ? encodeCursor(nextOffset, fingerprint) : null
          }
        }
      } catch (cause) {
        throw filesystemError(cause, "list", root)
      }
    }
  }),

  defineServerTool({
    name: "file_find",
    summary: "Finds files by name.",
    discovery: "always_loaded",
    description: [
      "Find file paths recursively by glob. Files listed in .gitignore and other ignore files are skipped, as are .git, node_modules, .venv, __pycache__ and folders the owner's rules hide.",
      "Results are capped without a cursor, so narrow path/pattern when has_more is true. A search stops with an error after 20 seconds. Use file_search_text to inspect contents."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(FindParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Find Files",
      kind: "filesystem",
      action: "read",
      approval_preview: "Find local files by name.",
      source: "_filesystem",
      changes_state: false,
      concurrency_group: "filesystem",
      destructive: null
    },
    execute: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const root = await resolveFor(cwd, input.path)
      try {
        if (!(await stat(root)).isDirectory())
          throw toolRefusal(`${root} is not a directory.`, "Not a directory")
        const found = await ripgrepFind({
          cwd: root,
          pattern: input.pattern,
          includeHidden: input.include_hidden,
          limit: input.limit + 1,
          signal: ctx.signal,
          skip: neverFoldersWithin(cwd, root)
        })
        const hasMore = found.truncated || found.items.length > input.limit
        const files = await Promise.all(
          found.items.slice(0, input.limit).map(async (relative) => {
            const absolute = path.resolve(root, relative)
            return { absolute, relative, size: (await stat(absolute)).size }
          })
        )
        const lines = files.map((file) => `${file.relative.padEnd(72)} ${formatBytes(file.size)}`)
        if (hasMore) lines.push("More files exist; narrow the path or pattern.")
        if (found.partial) lines.push(UNREADABLE_NOTE)
        const source_refs = files
          .slice(0, MAX_FOUND_SOURCES)
          .map((file) => foundSource(file.absolute, file.relative))
        return {
          host: { source_refs },
          result: `${displayFor(cwd, root)} / ${input.pattern}\n${lines.join("\n") || "No files found."}`,
          preview: `${countOf(files.length, "file")}${hasMore ? " (capped)" : ""}`,
          data: {
            source_refs,
            path: displayFor(cwd, root),
            absolute_path: root,
            pattern: input.pattern,
            matches: files.map((file) => ({
              path: displayFor(cwd, file.absolute),
              absolute_path: file.absolute,
              relative_path: file.relative,
              size: file.size
            })),
            has_more: hasMore,
            unreadable_skipped: found.partial,
            search_output_bytes: found.outputBytes
          }
        }
      } catch (cause) {
        throw filesystemError(cause, "find files under", root)
      }
    }
  }),

  defineServerTool({
    name: "file_search_text",
    summary: "Searches inside files for text.",
    discovery: "always_loaded",
    description: [
      "Search local UTF-8 files for literal text, including hidden files by default, in content, files-only, or count mode.",
      "Files listed in .gitignore and other ignore files are not searched, nor are .git, node_modules, .venv, __pycache__ and folders the owner's rules hide. A search stops with an error after 20 seconds.",
      "Continue with next_cursor only under the identical request; narrow path, glob, or query if the result window is exhausted.",
      "Use file_find instead when only the file name or path is known."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(SearchParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Search Text",
      kind: "filesystem",
      action: "read",
      approval_preview: "Search text in local files.",
      source: "_filesystem",
      changes_state: false,
      concurrency_group: "filesystem",
      destructive: null
    },
    execute: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const requested = await resolveFor(cwd, input.path)
      try {
        const requestedInfo = await stat(requested)
        const root = requestedInfo.isDirectory() ? requested : path.dirname(requested)
        const singleFile = requestedInfo.isFile() ? requested : null
        if (singleFile === null && !requestedInfo.isDirectory()) {
          throw toolRefusal(`${requested} is not a file or directory.`, "Invalid search path")
        }
        const fingerprint = sha256Hex(
          JSON.stringify({
            requested,
            query: input.query,
            glob: input.file_glob ?? null,
            mode: input.output_mode,
            includeHidden: input.include_hidden
          })
        )
        const offset = decodeCursor(input.cursor, fingerprint)
        const searchLimit = Math.min(MAX_DISCOVERY_ENTRIES + 1, offset + input.limit + 1)
        const target = singleFile === null ? "." : path.basename(singleFile)
        const request = {
          cwd: root,
          query: input.query,
          ...(input.file_glob === undefined ? {} : { fileGlob: input.file_glob }),
          target,
          includeHidden: input.include_hidden,
          skip: neverFoldersWithin(cwd, root),
          limit: searchLimit,
          signal: ctx.signal
        }
        const records: Array<
          Readonly<{ path: string; relative_path: string }> &
            Record<string, string | number | boolean>
        > = []
        let hasMore = false
        let partial = false
        let searchOutputBytes = 0
        const addPath = (candidate: string) => {
          const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
          return {
            path: absolute,
            relative_path: path.relative(root, absolute).split(path.sep).join("/")
          }
        }
        if (input.output_mode === SEARCH_OUTPUT_MODE.filesOnly) {
          const searched = await ripgrepSearchFiles(request)
          const selected = searched.items.slice(offset, offset + input.limit)
          records.push(...selected.map((candidate) => addPath(candidate)))
          partial = searched.partial
          hasMore = searched.truncated || searched.items.length > offset + selected.length
          searchOutputBytes = searched.outputBytes
        } else if (input.output_mode === SEARCH_OUTPUT_MODE.count) {
          const searched = await ripgrepSearchCounts(request)
          const selected = searched.items.slice(offset, offset + input.limit)
          records.push(
            ...selected.map((match) => ({
              ...addPath(match.path),
              count: match.count
            }))
          )
          partial = searched.partial
          hasMore = searched.truncated || searched.items.length > offset + selected.length
          searchOutputBytes = searched.outputBytes
        } else {
          const searched = await ripgrepSearchContent(request)
          const selected = searched.items.slice(offset, offset + input.limit)
          records.push(
            ...selected.map((match) => ({
              ...addPath(match.path),
              line: match.line,
              column: match.column,
              snippet: match.text,
              snippet_truncated: match.textTruncated
            }))
          )
          partial = searched.partial
          hasMore = searched.truncated || searched.items.length > offset + selected.length
          searchOutputBytes = searched.outputBytes
        }
        const nextOffset = offset + records.length
        const canContinue = hasMore && records.length > 0 && nextOffset < MAX_DISCOVERY_ENTRIES
        const resultWindowExhausted = hasMore && !canContinue
        const content =
          records.length === 0
            ? `No matches for ${JSON.stringify(input.query)} under ${displayFor(cwd, requested)}.`
            : records.map((record) => renderSearchRecord(record, input.output_mode)).join("\n")
        let continuation = ""
        if (canContinue) {
          continuation = "\nMore matches exist; continue with next_cursor or narrow the search."
        } else if (resultWindowExhausted) {
          continuation =
            "\nThe bounded result window is exhausted; narrow the path, glob, or query."
        }
        if (partial) continuation += `\n${UNREADABLE_NOTE}`
        const matchedFiles = new Map(records.map((record) => [record.path, record.relative_path]))
        const source_refs = [...matchedFiles]
          .slice(0, MAX_FOUND_SOURCES)
          .map(([absolute, relative]) => foundSource(absolute, relative))
        const previewUnit = input.output_mode === SEARCH_OUTPUT_MODE.filesOnly ? "file" : "match"
        return {
          host: { source_refs },
          result: `${content}${continuation}`,
          preview: `${countOf(records.length, previewUnit)}${hasMore ? " (capped)" : ""}`,
          data: {
            source_refs,
            path: displayFor(cwd, requested),
            absolute_path: requested,
            query: input.query,
            output_mode: input.output_mode,
            include_hidden: input.include_hidden,
            matches: records,
            search_output_bytes: searchOutputBytes,
            has_more: hasMore,
            unreadable_skipped: partial,
            result_window_exhausted: resultWindowExhausted,
            next_cursor: canContinue ? encodeCursor(nextOffset, fingerprint) : null
          }
        }
      } catch (cause) {
        throw filesystemError(cause, "search", requested)
      }
    }
  })
]
