import { quoted } from "@arden-hq/std/count"
import { Schema } from "effect"
import { boundary, CHAT_BROWSE_SCOPE, VERDICT } from "../execution/decide.js"
import { SPACE_KIND } from "@arden-hq/protocol/spaces"
import { refusalError } from "./refusal.js"
import type { ServerRunContext } from "./run-context.js"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"

export const BrowseScopeSchema = Schema.Literals(Object.values(CHAT_BROWSE_SCOPE)).annotate({
  description:
    "space (default): this chat's Space only; a chat in the Main Space already sees every chat. all_spaces: every Space and chats on none."
})

type BrowseScope = typeof BrowseScopeSchema.Type

export const permittedBrowseScope = (
  requested: BrowseScope | undefined,
  run: Pick<ServerRunContext, "authority">
): BrowseScope => {
  if (requested !== CHAT_BROWSE_SCOPE.allSpaces) return CHAT_BROWSE_SCOPE.space
  const verdict = boundary(run.authority, {
    kind: "chat_browse",
    scope: CHAT_BROWSE_SCOPE.allSpaces
  })
  if (verdict.kind !== VERDICT.allow)
    throw refusalError({
      what: "Only the user's own turn and a Space review browse every Space; this run browses its own Space's chats",
      rule: "boundary",
      instead: verdict.kind === VERDICT.deny ? verdict.instead : []
    })
  return CHAT_BROWSE_SCOPE.allSpaces
}

export const spaceLabel = (spaceName: string | undefined): string =>
  spaceName === undefined ? "no Space" : `Space ${quoted(spaceName)}`

export const seesEveryChat = (
  header: Pick<SessionHistoryHeader, "spaceId" | "spaceKind">,
  run: Pick<ServerRunContext, "authority">
): boolean =>
  header.spaceId === null ||
  (header.spaceKind === SPACE_KIND.main &&
    boundary(run.authority, { kind: "chat_browse", scope: CHAT_BROWSE_SCOPE.allSpaces }).kind ===
      VERDICT.allow)
