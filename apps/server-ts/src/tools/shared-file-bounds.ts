import { formatBytes } from "@arden-hq/std/count"
import { basename } from "node:path"

import { PRIVATE_FILE_VIOLATION, PrivateFileError, readRegularFile } from "../fs/private-store.js"
import { filesystemError } from "./file-tool-support.js"
import { toolRefusal } from "./tool-failure.js"

export const boundedFile = async (path: string, maxBytes: number): Promise<Buffer> => {
  try {
    return (await readRegularFile(path, maxBytes)).bytes
  } catch (cause) {
    if (cause instanceof PrivateFileError && cause.reason === PRIVATE_FILE_VIOLATION.tooLarge) {
      throw toolRefusal(
        `${basename(path)} exceeds the remaining file limit of ${formatBytes(maxBytes)}. Choose fewer or smaller files.`,
        "Files too large"
      )
    }
    throw filesystemError(cause, "read", path)
  }
}

export const enforceSize = (size: number, maximum: number, name: string): void => {
  if (size > maximum)
    throw toolRefusal(
      `${name} exceeds the remaining file limit of ${formatBytes(maximum)}. Choose fewer or smaller files.`,
      "Files too large"
    )
}
