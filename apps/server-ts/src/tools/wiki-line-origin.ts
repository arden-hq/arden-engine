import { ToolExecutionError, type ToolResultOutput } from "@arden-hq/loop"
import { Effect } from "effect"

import type { SessionQueries } from "../persistence/sessions/queries.js"
import { wikiOriginChat, wikiOriginSource } from "../wiki/commit.js"
import type { Wiki } from "../wiki/service.js"
import type { PageRecord } from "../wiki/snapshot.js"
import { wikiFailure } from "./wiki.js"
import { pageSource } from "./wiki-records.js"

type Sessions = Pick<SessionQueries["Service"], "loadHistoryHeader">

const chatLink = async (
  sessions: Sessions,
  sessionId: string,
  signal: AbortSignal
): Promise<string | undefined> => {
  const header = await Effect.runPromise(
    sessions.loadHistoryHeader(sessionId).pipe(Effect.orElseSucceed(() => null)),
    { signal }
  )
  return header === null ? undefined : `arden:session/${encodeURIComponent(header.publicRef)}`
}

const chatPhrase = async (
  sessions: Sessions,
  sessionId: string | undefined,
  signal: AbortSignal
): Promise<{ readonly phrase: string; readonly link: string | null }> => {
  if (sessionId === undefined) return { phrase: "", link: null }
  const link = await chatLink(sessions, sessionId, signal)
  return link === undefined
    ? { phrase: " in a chat that no longer exists", link: null }
    : { phrase: ` in ${link}`, link }
}

/** wiki_page_history's answer for one line: the change that added it. */
export const lineOriginOutput = async (
  { wiki, sessions }: { readonly wiki: Wiki["Service"]; readonly sessions: Sessions },
  record: PageRecord,
  line: string,
  signal: AbortSignal
): Promise<ToolResultOutput> => {
  const origin = await Effect.runPromise(
    wiki.lineOrigin(record.page.pageId, line).pipe(Effect.mapError(wikiFailure)),
    { signal }
  )
  switch (origin.kind) {
    case "absent":
      throw new ToolExecutionError(
        `That text is not on ${record.resource.path} now. Read the page and copy part of one line.`,
        { preview: "Line not found", retryable: false }
      )
    case "ambiguous":
      throw new ToolExecutionError(
        `That text is on ${origin.lines} lines of ${record.resource.path}. Give more of the one line you mean.`,
        { preview: "Line not unique", retryable: false }
      )
    case "added": {
      const chat = await chatPhrase(sessions, wikiOriginChat(origin.origin), signal)
      const source = wikiOriginSource(origin.origin)
      return {
        result: `"${origin.line}" on ${record.resource.path} was added ${origin.timestamp} by ${origin.actor} (${source})${chat.phrase}. Change: ${origin.reason}`,
        preview: "Line origin found",
        host: { source_refs: [pageSource(record, "read")] },
        data: {
          source_refs: [pageSource(record, "read")],
          path: record.resource.path,
          line: origin.line,
          added_at: origin.timestamp,
          actor: origin.actor,
          source,
          reason: origin.reason,
          chat: chat.link
        }
      }
    }
  }
}
