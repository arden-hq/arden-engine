import { McpServerNameSchema } from "@arden-hq/protocol/effect/mcp"
import { slugify } from "@arden-hq/std/slug"
import { Schema } from "effect"
import { normalizeServerUrl } from "../persistence/capability-offers/match.js"

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING = /[.,;:!?)\]}>]+$/

const addressesIn = (text: string): ReadonlyArray<string> =>
  (text.match(URL_IN_TEXT) ?? []).map((token) => token.replace(TRAILING, ""))

const isServerName = Schema.is(McpServerNameSchema)
const GENERIC_LABELS = new Set(["www", "mcp", "api"])

const serverLabel = (suggested: string | undefined, url: string): string => {
  const cleaned = (suggested ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32)
  if (isServerName(cleaned)) return cleaned
  const labels = new URL(url).hostname.split(".")
  const named = labels.filter((label) => !GENERIC_LABELS.has(label))
  const fromHost = slugify(named[0] ?? labels[0] ?? "")
  return isServerName(fromHost) ? fromHost : "server"
}

export type ServerRequestVerdict =
  | { readonly kind: "accepted"; readonly id: string; readonly url: string; readonly name: string }
  | {
      readonly kind: "refused"
      readonly reason: "child_agent" | "invalid_url" | "not_from_owner"
    }

export const vetServerRequest = (input: {
  readonly url: string
  readonly name?: string | undefined
  readonly ownerWords: ReadonlyArray<string>
  readonly childAgent: boolean
}): ServerRequestVerdict => {
  if (input.childAgent) return { kind: "refused", reason: "child_agent" }
  const wanted = normalizeServerUrl(input.url)
  if (wanted === undefined) return { kind: "refused", reason: "invalid_url" }
  for (const words of input.ownerWords) {
    for (const spelled of addressesIn(words)) {
      if (normalizeServerUrl(spelled) !== wanted) continue
      return {
        kind: "accepted",
        id: wanted,
        url: spelled,
        name: serverLabel(input.name, spelled)
      }
    }
  }
  return { kind: "refused", reason: "not_from_owner" }
}

export const refusalText = (
  reason: Extract<ServerRequestVerdict, { kind: "refused" }>["reason"]
) => {
  switch (reason) {
    case "child_agent":
      return "Only the main conversation can offer a server. Ask your parent agent to do it."
    case "invalid_url":
      return "That address cannot be offered: it must be https (http only for localhost) and carry no password."
    case "not_from_owner":
      return "That URL did not come from the user's messages, so no server was offered. Ask the user to write the address in chat."
  }
}
