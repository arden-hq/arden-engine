import { quoted } from "@arden-hq/std/count"
import { Schema } from "effect"
import { boundary } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import type { ServerRunContext } from "./run-context.js"

export const BrowseScopeSchema = Schema.Literals(["space", "all_spaces"] as const).annotate({
  description:
    "space (default): this chat's Space only; a chat on no Space already sees every chat. all_spaces: every Space and chats on none."
})

type BrowseScope = typeof BrowseScopeSchema.Type

export const permittedBrowseScope = (
  requested: BrowseScope | undefined,
  run: Pick<ServerRunContext, "authority">
): BrowseScope => {
  if (requested !== "all_spaces") return "space"
  const verdict = boundary(run.authority, { kind: "chat_browse", scope: "all_spaces" })
  if (verdict.kind !== "allow")
    throw refusalError({
      what: "Only the user's own turn and a Space review browse every Space; this run browses its own Space's chats",
      rule: "boundary",
      instead: verdict.kind === "deny" ? verdict.instead : []
    })
  return "all_spaces"
}

export const spaceLabel = (spaceName: string | undefined): string =>
  spaceName === undefined ? "no Space" : `Space ${quoted(spaceName)}`
