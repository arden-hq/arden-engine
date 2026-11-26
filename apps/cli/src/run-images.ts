import type { ChatImageInput } from "@arden-hq/protocol/chat"
import { errorMessage } from "@arden-hq/std/errors"
import { IMAGE_MEDIA_TYPE } from "@arden-hq/std/message-vocabulary"
import { extname } from "node:path"
import { isMediaExtension, MEDIA_EXTENSION, type MediaExtension } from "./cli-words.js"
import { UsageError, type CliDependencies } from "./command.js"

const MEDIA_TYPE_OF_EXTENSION: Readonly<Record<MediaExtension, ChatImageInput["mediaType"]>> = {
  [MEDIA_EXTENSION.png]: IMAGE_MEDIA_TYPE.png,
  [MEDIA_EXTENSION.jpg]: IMAGE_MEDIA_TYPE.jpeg,
  [MEDIA_EXTENSION.jpeg]: IMAGE_MEDIA_TYPE.jpeg
}

const imageMediaType = (path: string): ChatImageInput["mediaType"] => {
  const extension = extname(path).toLowerCase()
  const mediaType = isMediaExtension(extension) ? MEDIA_TYPE_OF_EXTENSION[extension] : undefined
  if (mediaType !== undefined) return mediaType
  throw new UsageError(`--image takes .png or .jpg files: ${path}`)
}

export const readImages = (
  paths: ReadonlyArray<string>,
  dependencies: CliDependencies
): Promise<Array<ChatImageInput>> =>
  Promise.all(
    paths.map(async (path) => {
      const mediaType = imageMediaType(path)
      let bytes: Uint8Array
      try {
        bytes = await dependencies.readFile(path)
      } catch (cause) {
        throw new UsageError(`Cannot read image ${path}: ${errorMessage(cause)}`)
      }
      return { mediaType, data: Buffer.from(bytes).toString("base64") }
    })
  )
