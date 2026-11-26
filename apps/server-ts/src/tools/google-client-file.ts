import { ToolExecutionError } from "@arden-hq/loop"
import { GoogleDesktopClientFileSchema } from "@arden-hq/protocol/effect/google"
import { GOOGLE_CLIENT_SECRET, type GoogleOAuthClient } from "@arden-hq/protocol/google"
import { Option, Schema } from "effect"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"

const MAX_CLIENT_FILE_BYTES = 64 * 1024

export const newestClientFile = async (downloads: string): Promise<string | undefined> => {
  const names = (await readdir(downloads).catch(() => [])).filter((name) =>
    /^client_secret_.*\.json$/.test(name)
  )
  const dated = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(downloads, name)).catch(() => undefined)
      return info?.isFile() === true ? [{ path: join(downloads, name), at: info.mtimeMs }] : []
    })
  )
  return dated.flat().sort((left, right) => right.at - left.at)[0]?.path
}

export const readClientFile = async (
  file: string
): Promise<{ readonly oauth: GoogleOAuthClient; readonly projectId: string }> => {
  const info = await stat(file).catch(() => undefined)
  if (info?.isFile() !== true || info.size > MAX_CLIENT_FILE_BYTES) {
    throw new ToolExecutionError(`${basename(file)} is not a Google client file.`, {
      preview: "Not a client file",
      retryable: false
    })
  }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(GoogleDesktopClientFileSchema))(
    await readFile(file, "utf8")
  )
  if (Option.isNone(decoded)) {
    throw new ToolExecutionError(
      `${basename(file)} is not a Desktop app OAuth client. In Google Cloud, create an OAuth client of type Desktop app and download its JSON.`,
      { preview: "Not a Desktop client", retryable: false }
    )
  }
  const installed = decoded.value.installed
  return {
    oauth: {
      clientId: installed.client_id,
      secret: { kind: GOOGLE_CLIENT_SECRET.confidential, clientSecret: installed.client_secret }
    },
    projectId: installed.project_id
  }
}
