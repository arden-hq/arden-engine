import { ToolExecutionError } from "@arden-hq/loop"
import { Effect } from "effect"
import { WIKI_ERROR_REASON, type WikiError } from "../wiki/errors.js"
import { nameKeys, namesTakenAt, normal } from "../wiki/page.js"
import { Wiki } from "../wiki/service.js"
import {
  activeRunPages,
  redirectTargetAt,
  type PageRecord,
  type Snapshot
} from "../wiki/snapshot.js"

const DOT_SEGMENTS: ReadonlyArray<string> = [".", ".."]

export const wikiFailure = (error: WikiError): ToolExecutionError => {
  switch (error.reason) {
    case WIKI_ERROR_REASON.not_found:
      return new ToolExecutionError(
        `${error.message} Call wiki_list_pages and retry with an exact active page path.`,
        { preview: "Memory page not found", retryable: false }
      )
    case WIKI_ERROR_REASON.conflict:
      return new ToolExecutionError(
        "Memory changed after it was read. Read the relevant page again, then retry.",
        { preview: "Memory changed", retryable: true }
      )
    case WIKI_ERROR_REASON.blocked:
      return new ToolExecutionError(error.message, {
        preview: "Memory write blocked",
        retryable: false
      })
    case WIKI_ERROR_REASON.invalid:
      return new ToolExecutionError(
        `The Memory page path, metadata, or Markdown body is invalid: ${error.message}`,
        { preview: "Invalid Memory page", retryable: false }
      )
    case WIKI_ERROR_REASON.closed:
      return new ToolExecutionError("Memory is closed because Arden is shutting down.", {
        preview: "Memory closed",
        retryable: false
      })
    case WIKI_ERROR_REASON.corrupt:
      return new ToolExecutionError(error.message, {
        preview: "Memory storage failed",
        retryable: false
      })
    case WIKI_ERROR_REASON.storage:
      return new ToolExecutionError(error.message, {
        preview: "Memory storage failed",
        retryable: true
      })
  }
}

export const parseDirectory = (value: string): string | null => {
  if (value === "") return ""
  if (value.startsWith("/")) return null
  if (value.includes("\\")) return null
  const directory = value.endsWith("/") ? value.slice(0, -1) : value
  if (directory === "") return null
  const parts = directory.split("/")
  if (parts.some((part) => part === "")) return null
  if (parts.some((part) => DOT_SEGMENTS.includes(part))) return null
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
