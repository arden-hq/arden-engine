import { LOCAL_FOLDER_LIMITS } from "@arden-hq/protocol/spaces"
import { access } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

import type { SpaceFolderApprovalData } from "../persistence/permissions/space-folder-approval.js"
import { ardenStateRoot, realHome, type LocalPathServices } from "../storage/local-paths.js"
import type { ServerRunContext } from "./run-context.js"
import { tooWide } from "../fs/protected-paths.js"

export interface FolderGrant {
  readonly place: "space"
  readonly id: string
  readonly folder: string
}

interface GrantRoots {
  readonly stateRoots: ReadonlyArray<string>
  readonly home: string
}

type GrantContext = { readonly run: ServerRunContext; readonly signal: AbortSignal }

const grantableFolder = async (
  targets: ReadonlyArray<string>,
  {
    stateRoots,
    home = realHome()
  }: { readonly stateRoots: ReadonlyArray<string>; readonly home?: string }
): Promise<string | undefined> => {
  const roots = { stateRoots, home }
  const folders = new Set(
    await Promise.all(targets.map((target) => projectOf(path.dirname(target), roots)))
  )
  const [folder] = folders
  return folders.size === 1 && folder !== undefined && !tooWide(folder, roots) ? folder : undefined
}

const projectOf = async (folder: string, roots: GrantRoots): Promise<string> => {
  for (let dir = folder; !tooWide(dir, roots); dir = path.dirname(dir)) {
    if (await exists(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) break
  }
  return folder
}

const exists = (target: string): Promise<boolean> =>
  access(target).then(
    () => true,
    () => false
  )

export const offerFolderGrant = async (
  services: Pick<LocalPathServices, "spaces" | "sessions" | "dataDir">,
  ctx: GrantContext,
  targets: ReadonlyArray<string>
): Promise<FolderGrant | undefined> => {
  const folder = await grantableFolder(targets, {
    stateRoots: [ardenStateRoot(services.dataDir)]
  })
  return folder === undefined ? undefined : folderGrantFor(services, ctx, folder)
}

export const folderGrantFor = async (
  services: Pick<LocalPathServices, "spaces" | "sessions" | "dataDir">,
  ctx: GrantContext,
  folder: string
): Promise<FolderGrant | undefined> => {
  if (
    folder.length > LOCAL_FOLDER_LIMITS.length ||
    tooWide(folder, { stateRoots: [ardenStateRoot(services.dataDir)], home: realHome() })
  )
    return undefined
  const snapshot = await Effect.runPromise(
    services.sessions.loadHeaderSnapshot(ctx.run.sessionId),
    { signal: ctx.signal }
  )
  const spaceId = snapshot?.header.spaceId ?? null
  if (spaceId === null) return undefined
  const space = await Effect.runPromise(services.spaces.get(spaceId), { signal: ctx.signal })
  return space !== null && space.archived_at == null
    ? { place: "space", id: spaceId, folder }
    : undefined
}

export const grantData = (grant: FolderGrant) =>
  ({
    space_folder_grant: {
      _tag: "SpaceFolderGrant",
      space_id: grant.id,
      local_folder: grant.folder
    }
  }) satisfies Pick<SpaceFolderApprovalData, "space_folder_grant">
