import { publicWebUrl } from "@arden-hq/std/url"
import { clipLine, cutText } from "@arden-hq/std/text"
import type { JsonObject, JsonValue, ProviderToolCall } from "../../contracts/messages.js"
import {
  asRecord,
  WEB_SEARCH_TOOL_NAME,
  type OutputItem,
  type ResponseShape,
  type WebSearchOutputItem
} from "./items.js"

const MAX_WEB_SOURCE_REFS = 20
const MAX_PROVIDER_RESULT_CHARS = 20_000

type WebSourceRef = JsonObject & {
  readonly provider: "web"
  readonly kind: "page"
  readonly ref: string
  readonly title: string
  readonly url: string
}

const boundedLine = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null
  const text = clipLine(value, limit)
  return text.length === 0 ? null : text
}

const webUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const page = publicWebUrl(value)
  return page.kind === "ok" ? page.url.toString() : null
}

const sourceRef = (value: unknown): WebSourceRef | null => {
  const source = asRecord(value)
  if (source?.type !== "url" && source?.type !== "url_citation") return null
  const url = webUrl(source.url)
  if (url === null) return null
  const title = boundedLine(source.title, 256) ?? new URL(url).hostname
  return { provider: "web", kind: "page", ref: url, title, url }
}

const itemCitations = (item: OutputItem): ReadonlyArray<WebSourceRef> => {
  if (item.type !== "message") return []
  return item.content.flatMap((part) => {
    if (part.type !== "output_text") return []
    return part.annotations.flatMap((annotation) => {
      const ref = sourceRef(annotation)
      return ref === null ? [] : [ref]
    })
  })
}

const citedSources = (response: ResponseShape): ReadonlyArray<WebSourceRef> =>
  response.output.flatMap(itemCitations)

const searchSources = (
  item: WebSearchOutputItem,
  citations: ReadonlyArray<WebSourceRef>
): ReadonlyArray<WebSourceRef> => {
  const actionSources = Array.isArray(item.action?.sources)
    ? item.action.sources.flatMap((source) => {
        const ref = sourceRef(source)
        return ref === null ? [] : [ref]
      })
    : []
  const unique = new Map<string, WebSourceRef>()
  for (const ref of [...citations, ...actionSources]) {
    if (!unique.has(ref.ref)) unique.set(ref.ref, ref)
    if (unique.size >= MAX_WEB_SOURCE_REFS) break
  }
  return [...unique.values()]
}

export const searchArguments = (item: WebSearchOutputItem): Readonly<Record<string, JsonValue>> => {
  const action = item.action
  if (action === undefined) return {}
  const values: Record<string, JsonValue> = {}
  for (const [key, limit] of [
    ["type", 64],
    ["query", 1_000],
    ["url", 4_096],
    ["pattern", 1_000]
  ] as const) {
    const value = boundedLine(action[key], limit)
    if (value !== null) values[key] = value
  }
  if (Array.isArray(action.queries)) {
    values.queries = action.queries.slice(0, 20).flatMap((query) => {
      const value = boundedLine(query, 1_000)
      return value === null ? [] : [value]
    })
  }
  return values
}

const searchAction = (args: Readonly<Record<string, JsonValue>>): string => {
  if (typeof args.query === "string") return `Searched for: ${args.query}`
  if (typeof args.url === "string") return `Opened: ${args.url}`
  return "Searched the web."
}

const searchResult = (item: WebSearchOutputItem, sources: ReadonlyArray<WebSourceRef>): string => {
  const args = searchArguments(item)
  const action = searchAction(args)
  const result =
    sources.length === 0
      ? action
      : `${action}\n\nSources:\n${sources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`
  return cutText(result, MAX_PROVIDER_RESULT_CHARS, { suffix: "\n[Source summary truncated.]" })
}

export const webSearchCalls = (response: ResponseShape): ReadonlyArray<ProviderToolCall> => {
  const citations = citedSources(response)
  return response.output.flatMap((item): ReadonlyArray<ProviderToolCall> => {
    if (item.type !== "web_search_call") return []
    const sources = searchSources(item, citations)
    return [
      {
        id: item.id,
        name: WEB_SEARCH_TOOL_NAME,
        arguments: searchArguments(item),
        result: searchResult(item, sources),
        done: true,
        loaded_tool_names: [],
        source_refs: sources
      }
    ]
  })
}
