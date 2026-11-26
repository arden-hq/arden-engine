import { ToolExecutionError } from "@arden-hq/loop"

import { type PageRecord } from "../wiki/snapshot.js"
import {
  WIKI_LINK_ANCHOR,
  WIKI_LINK_LABEL,
  WIKI_LINK_STATUS,
  type WikiLink
} from "@arden-hq/protocol/wiki"

const exactOccurrences = (body: string, text: string): number => body.split(text).length - 1

export const patchedBody = (
  record: PageRecord,
  input: { readonly old_text: string; readonly new_text: string }
): string => {
  const occurrences = exactOccurrences(record.page.body, input.old_text)
  if (occurrences !== 1) {
    throw new ToolExecutionError(
      occurrences === 0
        ? "old_text was not found in the current Memory page body."
        : `old_text matches ${occurrences} places in the current Memory page body.`,
      { preview: "Patch not applied", retryable: false }
    )
  }
  const body = record.page.body.replace(input.old_text, () => input.new_text)
  if (body.trim().length === 0) {
    throw new ToolExecutionError(
      "A Memory page must retain content. Archive it to remove the page.",
      {
        preview: "Patch not applied",
        retryable: false
      }
    )
  }
  return body
}

export const directoryOutcome = (
  directory: string,
  pagePath: string,
  changed: boolean,
  adopted: boolean
): { readonly result: string; readonly preview: string } => {
  if (!changed) {
    return {
      result: `Wiki directory ${directory}/ already has the requested contract.`,
      preview: "Wiki directory unchanged"
    }
  }
  if (adopted) {
    return {
      result: `Opened ${directory}.md as ${pagePath} with the same page identity and history.`,
      preview: "Wiki directory opened"
    }
  }
  return {
    result: `Created Wiki directory ${directory}/ with contract ${pagePath}.`,
    preview: "Wiki directory created"
  }
}

export type LinkData = {
  readonly source_page_id: string
  readonly source_path: string | null
  readonly target: string
  readonly alias: string | null
  readonly heading: string | null
  readonly status: "resolved" | "unresolved"
  readonly target_page_id: string | null
  readonly target_path: string | null
}

export const linkData = (link: WikiLink, paths: ReadonlyMap<string, string>): LinkData => {
  const targetPageId = link.status === WIKI_LINK_STATUS.resolved ? link.targetPageId : null
  return {
    source_page_id: link.sourcePageId,
    source_path: paths.get(link.sourcePageId) ?? null,
    target: link.target,
    alias: link.label.kind === WIKI_LINK_LABEL.alias ? link.label.alias : null,
    heading: link.anchor.kind === WIKI_LINK_ANCHOR.heading ? link.anchor.heading : null,
    status: link.status,
    target_page_id: targetPageId,
    target_path: targetPageId === null ? null : (paths.get(targetPageId) ?? null)
  }
}
