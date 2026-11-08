import { countOf, formatBytes } from "@arden-hq/std/count"
import { Effect, Option, Schema } from "effect"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { ManagedOutputWriter } from "../artifacts/managed-output/managed-output.js"
import { isManagedObjectRef } from "../artifacts/managed-output/object-store.js"
import { neverFoldersWithin, type LocalPathServices } from "../storage/local-paths.js"
import { bodyFields } from "./code-mode-result.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { cwdFor, displayFor, filesystemError, PathSchema, resolveFor } from "./file-tool-support.js"
import {
  binaryRefusal,
  fileKind,
  imageConversionRefusal,
  imageForModel,
  imageNote,
  imageRefusal,
  pdfRefusal,
  readPdfText
} from "./read-binary.js"
import { readTextPage } from "./read-text.js"
import type { ServerRunContext } from "./run-context.js"
import { selectText, textSelectFields } from "./text-select.js"
import {
  ripgrepFind,
  ripgrepSearchContent,
  ripgrepSearchCounts,
  ripgrepSearchFiles
} from "./ripgrep.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"

const offerPage = (
  ctx: { readonly toolCallId: string; readonly run: ServerRunContext },
  source: string,
  window: { readonly offset: number; readonly limit: number }
): void =>
  ctx.run.codeMode.scriptFields(ctx.toolCallId, () =>
    bodyFields(readTextPage(source, { ...window, format: "plain" }).content)
  )

const MAX_DISCOVERY_ENTRIES = 100_000
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024

const ReadOffsetSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000_000 })
).pipe(
  Schema.withDecodingDefault(Effect.succeed(1)),
  Schema.annotateEncoded({
    description: "First 1-based line to return (1-10,000,000). Defaults to 1."
  })
)

const ReadLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })).pipe(
  Schema.withDecodingDefault(Effect.succeed(500)),
  Schema.annotateEncoded({
    description: "Maximum lines to return (1-10,000). Defaults to 500."
  })
)

const EntryLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(
  Schema.withDecodingDefault(Effect.succeed(200)),
  Schema.annotateEncoded({
    description: "Maximum entries to return (1-1,000). Defaults to 200."
  })
)

const MatchLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(
  Schema.withDecodingDefault(Effect.succeed(100)),
  Schema.annotateEncoded({
    description: "Maximum match records to return (1-1,000). Defaults to 100."
  })
)

const CursorSchema = Schema.optionalKey(
  Schema.String.check(Schema.isMaxLength(1_000)).annotate({
    description:
      "Opaque next_cursor from the preceding page; reuse only with the identical request."
  })
)

const ReadParametersSchema = Schema.Struct({
  path: PathSchema.annotate({
    description:
      "Local file path or an arden:managed-output reference from this Session. Relative file paths use the current Local folder."
  }),
  offset: ReadOffsetSchema,
  limit: ReadLimitSchema,
  line_numbers: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateEncoded({
      description:
        "Prefix each source line with its 1-based number (number|text). Defaults to true. Set false for plain text."
    })
  ),
  ...textSelectFields
})

const ListParametersSchema = Schema.Struct({
  path: PathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
    Schema.annotateEncoded({
      description:
        "Directory to list. Relative paths use the current Local folder; defaults to '.'."
    })
  ),
  limit: EntryLimitSchema,
  include_hidden: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateEncoded({
      description: "Include entries whose names start with '.'. Defaults to false."
    })
  ),
  cursor: CursorSchema
})

const FindParametersSchema = Schema.Struct({
  path: PathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
    Schema.annotateEncoded({
      description:
        "Directory root for recursive discovery. Relative paths use the current Local folder; defaults to '.'."
    })
  ),
  pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)).pipe(
    Schema.withDecodingDefault(Effect.succeed("*")),
    Schema.annotateEncoded({
      description: "File-path glob such as '**/*.ts' (1-1,024 characters). Defaults to '*'."
    })
  ),
  limit: EntryLimitSchema,
  include_hidden: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateEncoded({
      description:
        "Include hidden files while still respecting ignore files and fixed exclusions. Defaults to false."
    })
  )
})

const SearchParametersSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
    description:
      "Literal, case-sensitive text to search for; not a regular expression (1-4,096 characters)."
  }),
  path: PathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
    Schema.annotateEncoded({
      description:
        "File or directory to search. Relative paths use the current Local folder; defaults to '.'."
    })
  ),
  file_glob: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)).annotate({
      description: "Optional file-path glob such as '**/*.ts'; it filters files, not matched text."
    })
  ),
  output_mode: Schema.Literals(["content", "files_only", "count"] as const).pipe(
    Schema.withDecodingDefault(Effect.succeed("content" as const)),
    Schema.annotateEncoded({
      description:
        "Return matching lines, matching file paths, or per-file counts. Defaults to content."
    })
  ),
  include_hidden: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateEncoded({
      description:
        "Search hidden files while still excluding VCS/dependency/cache directories. Defaults to true."
    })
  ),
  limit: MatchLimitSchema,
  cursor: CursorSchema
})

const renderRead = (
  text: string,
  input: Schema.Schema.Type<typeof ReadParametersSchema>
): {
  readonly result: string
  readonly preview: string
  readonly total_lines: number
  readonly has_more: boolean
  readonly matches?: number
} => {
  if (input.grep !== undefined) {
    const selected = selectText(text, input)
    return {
      result: selected.text,
      preview: `${countOf(selected.matches, "matching line")} of ${selected.lines}`,
      total_lines: selected.lines,
      has_more: selected.truncated,
      matches: selected.matches
    }
  }
  const rendered = readTextPage(text, {
    ...input,
    format: input.line_numbers ? "numbered" : "plain"
  })
  return {
    result: rendered.notice ? `${rendered.content}\n\n${rendered.notice}` : rendered.content,
    preview: `Read ${rendered.shown} of ${rendered.total} lines`,
    total_lines: rendered.total,
    has_more: rendered.hasMore
  }
}

const PageCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  offset: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_DISCOVERY_ENTRIES)
  ),
  fingerprint: Schema.String
})

const encodeCursor = (offset: number, fingerprint: string): string =>
  encodeOpaque({ version: 1, offset, fingerprint })

const decodeCursor = (cursor: string | undefined, fingerprint: string): number => {
  if (cursor === undefined) return 0
  const value = Option.getOrUndefined(decodeOpaque(PageCursorSchema, cursor))
  if (value === undefined || value.fingerprint !== fingerprint) {
    throw toolRefusal(
      "The pagination cursor is invalid or belongs to another request.",
      "Invalid cursor"
    )
  }
  return value.offset
}

const entryKind = (entry: {
  readonly isDirectory: () => boolean
  readonly isFile: () => boolean
}): string => {
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  return "other"
}

const MAX_FOUND_SOURCES = 50

const foundSource = (absolute: string, title: string) => ({
  provider: "file",
  kind: "file",
  ref: absolute,
  title,
  use: "found" as const,
  href: pathToFileURL(absolute).href
})

const renderSearchRecord = (
  record: Readonly<Record<string, string | number | boolean>>,
  mode: "content" | "files_only" | "count"
): string => {
  if (mode === "content") {
    return `${record.relative_path}:${record.line}:${record.column}: ${record.snippet}`
  }
  if (mode === "count") return `${record.relative_path}: ${record.count}`
  return String(record.relative_path)
}

export const fileReadTools = ({
  outputs,
  ...services
}: LocalPathServices & {
  readonly outputs: ManagedOutputWriter
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "file_read",
    description: [
      "Read a known UTF-8 file with compact 1-based line numbers (number|text) by default; set line_numbers=false for plain text. Partial reads include the next 1-based offset when more content remains. To find something in a large file, set grep (a regular expression) instead of reading it all: it searches the whole file (offset, limit and line_numbers are ignored) and returns only the matching lines with grep_context lines around them.",
      "A PDF reads as its text, with a [Page N of M] line before each page, paged by the same offset and limit. A PNG, JPEG, GIF, WebP or HEIC image is shown to you as an image when this model takes images. Other binary files (Word, Excel, ZIP and the like) are refused; convert them with exec_command.",
      "Read a managed-output reference shown in a tool result through path; it must belong to this Session. Relative file paths use the current Local folder. Use file_find for names or file_search_text for content discovery. Line-number prefixes are not file content; omit them from edit/write inputs."
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
        if (info.size > MAX_SEARCH_FILE_BYTES * 8) {
          throw toolRefusal(
            `File is larger than ${formatBytes(MAX_SEARCH_FILE_BYTES * 8)}. Read a smaller file or use exec_command with a bounded command.`,
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
        if (kind.kind === "binary") {
          throw toolRefusal(binaryRefusal(name, kind.label), "Not a text file")
        }
        if (kind.kind === "image") {
          const limits = ctx.run.imageInput
          if (limits === undefined) {
            throw toolRefusal(imageRefusal(name, kind.format), "Images not supported")
          }
          const image = await imageForModel({
            file: target,
            bytes,
            format: kind.format,
            limits,
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
        const pdf = kind.kind === "pdf" ? await readPdfText(bytes) : undefined
        if (pdf !== undefined && pdf.kind !== "text") {
          throw toolRefusal(
            pdfRefusal(name, pdf, ctx.run.imageInput !== undefined),
            pdf.kind === "no_text" ? "PDF has no text" : "PDF not readable"
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
    description: [
      "List one directory's immediate children with type, size, and modification time.",
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
            const info = await stat(absolute)
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
    description: [
      "Find file paths recursively by glob with ignore-file semantics; common dependency, cache, and VCS directories are skipped.",
      "Results are capped without a cursor, so narrow path/pattern when has_more is true. Use file_search_text to inspect contents."
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
        const hasMore = found.partial || found.truncated || found.items.length > input.limit
        const files = await Promise.all(
          found.items.slice(0, input.limit).map(async (relative) => {
            const absolute = path.resolve(root, relative)
            return { absolute, relative, size: (await stat(absolute)).size }
          })
        )
        const lines = files.map((file) => `${file.relative.padEnd(72)} ${formatBytes(file.size)}`)
        if (hasMore) lines.push("More files exist; narrow the path or pattern.")
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
    description: [
      "Search local UTF-8 files for literal text, including hidden files by default, in content, files-only, or count mode.",
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
        let searchOutputBytes = 0
        const addPath = (candidate: string) => {
          const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
          return {
            path: absolute,
            relative_path: path.relative(root, absolute).split(path.sep).join("/")
          }
        }
        if (input.output_mode === "files_only") {
          const searched = await ripgrepSearchFiles(request)
          const selected = searched.items.slice(offset, offset + input.limit)
          records.push(...selected.map((candidate) => addPath(candidate)))
          hasMore =
            searched.partial ||
            searched.truncated ||
            searched.items.length > offset + selected.length
          searchOutputBytes = searched.outputBytes
        } else if (input.output_mode === "count") {
          const searched = await ripgrepSearchCounts(request)
          const selected = searched.items.slice(offset, offset + input.limit)
          records.push(
            ...selected.map((match) => ({
              ...addPath(match.path),
              count: match.count
            }))
          )
          hasMore =
            searched.partial ||
            searched.truncated ||
            searched.items.length > offset + selected.length
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
          hasMore =
            searched.partial ||
            searched.truncated ||
            searched.items.length > offset + selected.length
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
        const matchedFiles = new Map(records.map((record) => [record.path, record.relative_path]))
        const source_refs = [...matchedFiles]
          .slice(0, MAX_FOUND_SOURCES)
          .map(([absolute, relative]) => foundSource(absolute, relative))
        const previewUnit = input.output_mode === "files_only" ? "file" : "match"
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
