import { APPROVAL_GRANT_FOLDER, type ApprovalGrantFolder } from "@arden-hq/protocol/chat"
import { collapseHome } from "@arden-hq/std/paths"
import { cutText } from "@arden-hq/std/text"

import { spaceFolderGrantOf } from "./space-folder-approval.js"

const GRANT_FOLDER_TEXT = 40

export const grantFolderOf = (toolName: string, data: unknown): ApprovalGrantFolder => {
  const folder = spaceFolderGrantOf(toolName, data)?.local_folder
  return folder === undefined
    ? { kind: APPROVAL_GRANT_FOLDER.none }
    : { kind: APPROVAL_GRANT_FOLDER.folder, folder: shortFolder(collapseHome(folder)) }
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
