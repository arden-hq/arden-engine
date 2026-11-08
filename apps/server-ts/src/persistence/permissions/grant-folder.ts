import { collapseHome } from "@arden-hq/std/paths"
import { cutText } from "@arden-hq/std/text"

import { spaceFolderGrantOf } from "./space-folder-approval.js"

const GRANT_FOLDER_TEXT = 40

export const grantFolderField = (
  toolName: string,
  data: unknown
): { readonly grant_folder?: string } => {
  const folder = spaceFolderGrantOf(toolName, data)?.local_folder
  return folder === undefined ? {} : { grant_folder: shortFolder(collapseHome(folder)) }
}

const shortFolder = (shown: string): string => {
  if (shown.length <= GRANT_FOLDER_TEXT) return shown
  const [first, ...rest] = shown.split("/")
  const head = first === "~" ? "~/…" : "…"
  const kept: string[] = []
  for (const part of rest.toReversed()) {
    if (kept.length > 0 && [head, part, ...kept].join("/").length > GRANT_FOLDER_TEXT) break
    kept.unshift(part)
  }
  return cutText([head, ...kept].join("/"), GRANT_FOLDER_TEXT)
}
