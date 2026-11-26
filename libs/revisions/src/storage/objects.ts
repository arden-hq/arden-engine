import { OBJECT_KIND, type ObjectKind } from "../domain/format.js"

const OBJECT_DIRECTORY: Readonly<Record<ObjectKind, string>> = {
  blob: "objects/blobs",
  tree: "objects/trees",
  commit: "commits"
}

export const objectDirectory = (kind: ObjectKind): string => OBJECT_DIRECTORY[kind]

export const isJsonlObject = (kind: ObjectKind): boolean => kind !== OBJECT_KIND.blob

export const objectFilename = (kind: ObjectKind, id: string): string =>
  isJsonlObject(kind) ? `${id}.jsonl` : id

export const objectLocation = (kind: ObjectKind, id: string): string =>
  `${objectDirectory(kind)}/${objectFilename(kind, id)}`
