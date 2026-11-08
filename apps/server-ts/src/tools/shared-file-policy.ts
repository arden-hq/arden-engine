import { expandHome, isWithin } from "@arden-hq/std/paths"
import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export interface UploadRoots {
  readonly folders: ReadonlyArray<string>
  readonly artifacts: ReadonlyArray<string>
  readonly attachedPaths?: ReadonlyArray<string>
  readonly userUploadRoots?: ReadonlyArray<string>
  readonly stateRoots: ReadonlyArray<string>
  readonly home?: string
}

export type UploadRefusal =
  | "arden_internal"
  | "hidden"
  | "secret"
  | "missing"
  | "not_a_file"
  | "no_attachment"
  | "no_artifact"

export type UploadPathCheck =
  | {
      readonly kind: "allowed" | "outside"
      readonly path: string
      readonly name: string
      readonly size: number
    }
  | { readonly kind: "refused"; readonly reason: UploadRefusal }

const refused = (reason: UploadRefusal): UploadPathCheck => ({ kind: "refused", reason })

export const checkUploadPath = async ({
  path: rawPath,
  roots
}: {
  readonly path: string
  readonly roots: UploadRoots
}): Promise<UploadPathCheck> => {
  const target = await realFile(expandPath(rawPath, roots.folders[0]))
  if (target.kind === "refused") return target
  const explicitlyAttached = (await realRoots(roots.attachedPaths ?? [])).includes(target.path)
  const artifactRoot = (await realRoots(roots.artifacts)).find((root) =>
    isWithin(root, target.path)
  )
  const stateRoots = await realRoots(roots.stateRoots)
  const inState = stateRoots.some((root) => isWithin(root, target.path))
  const inUploads = (await realRoots(roots.userUploadRoots ?? [])).some((root) =>
    isWithin(root, target.path)
  )
  const allowedAttachment = explicitlyAttached && (!inState || inUploads)
  if (!allowedAttachment && artifactRoot === undefined && inState) {
    return refused("arden_internal")
  }
  const root =
    artifactRoot ??
    (allowedAttachment ? path.dirname(target.path) : undefined) ??
    (await realRoots(roots.folders)).find((folder) => isWithin(folder, target.path))
  const checked = allowedAttachment && !inUploads ? target.path : checkedPath(root, target.path)
  if (checked.split(path.sep).some((segment) => segment.startsWith("."))) return refused("hidden")
  if (looksLikeSecret(path.basename(target.path))) return refused("secret")
  const home = roots.home ?? homedir()
  if ((root === undefined || allowedAttachment) && inKeyStore(target.path, home))
    return refused("secret")
  if (root !== undefined) return target
  return { ...target, kind: "outside" }
}

export const uploadRefusalText = (reason: UploadRefusal): string => {
  switch (reason) {
    case "arden_internal":
      return "That file is part of Arden's own data, so Arden won't upload it. Only files Arden made for you can leave that folder."
    case "hidden":
      return "That file is hidden or sits in a hidden folder, so Arden won't upload it."
    case "secret":
      return "That file looks like a key or a credential, so Arden won't upload it."
    case "missing":
      return "That file doesn't exist."
    case "not_a_file":
      return "That path is a folder or a special file, not a file Arden can upload."
    case "no_attachment":
      return "There is no attached file with that number in this chat."
    case "no_artifact":
      return "There is no file with that artifact_ref in this chat."
  }
}

const expandPath = (rawPath: string, base: string | undefined): string => {
  const expanded = expandHome(rawPath)
  if (path.isAbsolute(expanded) || base === undefined) return path.resolve(expanded)
  return path.resolve(base, expanded)
}

const realFile = async (target: string): Promise<UploadPathCheck> => {
  const real = await realpath(target).catch(() => undefined)
  if (real === undefined) return refused("missing")
  const info = await stat(real)
  return info.isFile()
    ? { kind: "allowed", path: real, name: path.basename(real), size: info.size }
    : refused("not_a_file")
}

const realRoots = async (roots: ReadonlyArray<string>): Promise<ReadonlyArray<string>> =>
  (await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))).filter(
    (root): root is string => root !== undefined
  )

const SECRET_NAME =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx|keychain|keychain-db|gpg|asc)|credentials(?:\.json)?|.*\.env)$/iu

const looksLikeSecret = (name: string): boolean => SECRET_NAME.test(name)

const KEY_STORES = (home: string): ReadonlyArray<string> => [
  path.join(home, "Library", "Keychains"),
  path.join(home, "Library", "Cookies"),
  "/Library/Keychains",
  "/etc",
  "/private/etc"
]

const inKeyStore = (file: string, home: string): boolean =>
  KEY_STORES(home).some((store) => isWithin(store, file))

const checkedPath = (root: string | undefined, target: string): string =>
  root === undefined ? target : path.relative(root, target)
