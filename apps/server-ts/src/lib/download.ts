import { Effect, Schema } from "effect"
import { createHash, type Hash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

export interface DownloadFile {
  readonly path: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

export class DownloadError extends Schema.TaggedError<DownloadError>()("DownloadError", {
  reason: Schema.Literals(["http", "incomplete", "size", "hash", "io"]),
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

interface FileDownloadOptions {
  readonly file: DownloadFile
  readonly destination: string
  readonly fetch: Fetch
  readonly onBytes: (receivedBytes: number) => void
}

const fail = (
  reason: DownloadError["reason"],
  file: DownloadFile,
  message: string,
  cause?: unknown
) =>
  new DownloadError({
    reason,
    path: file.path,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const sizeOf = async (file: string): Promise<number | undefined> => {
  const details = await stat(file).catch(() => undefined)
  return details?.isFile() === true ? details.size : undefined
}

const hashInto = async (hash: Hash, file: string) => {
  for await (const chunk of createReadStream(file)) hash.update(chunk)
}

const contentRangeStart = (response: Response): number | undefined => {
  const match = /^bytes (\d+)-/u.exec(response.headers.get("content-range") ?? "")
  return match?.[1] === undefined ? undefined : Number(match[1])
}

const appendBody = async (
  options: FileDownloadOptions,
  partial: string,
  response: Response,
  offset: number,
  hash: Hash
): Promise<number> => {
  if (response.body === null) return offset
  const handle = await open(partial, offset === 0 ? "w" : "a", 0o600)
  let received = offset
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > options.file.bytes) return received
      await handle.write(chunk)
      hash.update(chunk)
      options.onBytes(received)
    }
    return received
  } finally {
    await handle.close()
  }
}

export const downloadFile = Effect.fn("Downloads.file")(function* (options: FileDownloadOptions) {
  const { file, destination } = options
  if ((yield* Effect.promise(() => sizeOf(destination))) === file.bytes) {
    const hash = createHash("sha256")
    yield* Effect.promise(() => hashInto(hash, destination))
    if (hash.digest("hex") === file.sha256) {
      options.onBytes(file.bytes)
      return
    }
    yield* Effect.promise(() => rm(destination, { force: true }))
  }
  const partial = `${destination}.partial`
  yield* Effect.tryPromise({
    try: () => mkdir(path.dirname(destination), { recursive: true }),
    catch: (cause) => fail("io", file, "Could not create the model folder", cause)
  })

  const received = yield* Effect.tryPromise({
    try: async (signal) => {
      const onDisk = (await sizeOf(partial)) ?? 0
      const kept = onDisk <= file.bytes ? onDisk : 0
      const hash = createHash("sha256")
      if (kept > 0) await hashInto(hash, partial)
      if (kept === file.bytes) return { kind: "done" as const, bytes: kept, hash }
      const response = await options.fetch(file.url, {
        redirect: "follow",
        signal,
        ...(kept > 0 ? { headers: { range: `bytes=${kept}-` } } : {})
      })
      if (response.status === 206 && contentRangeStart(response) === kept) {
        return {
          kind: "done" as const,
          bytes: await appendBody(options, partial, response, kept, hash),
          hash
        }
      }
      if (response.status === 200) {
        // The server ignored the Range header: start the file over.
        const fresh = createHash("sha256")
        return {
          kind: "done" as const,
          bytes: await appendBody(options, partial, response, 0, fresh),
          hash: fresh
        }
      }
      await response.body?.cancel()
      return { kind: "http" as const, status: response.status }
    },
    catch: (cause) =>
      fail("incomplete", file, "The download stopped before the file was complete", cause)
  })

  if (received.kind === "http") {
    return yield* fail("http", file, `The server answered HTTP ${received.status}`)
  }
  if (received.bytes > file.bytes) {
    yield* Effect.promise(() => rm(partial, { force: true }))
    return yield* fail("size", file, `The server sent more than ${file.bytes} bytes`)
  }
  if (received.bytes < file.bytes) {
    return yield* fail("incomplete", file, `Received ${received.bytes} of ${file.bytes} bytes`)
  }
  if (received.hash.digest("hex") !== file.sha256) {
    yield* Effect.promise(() => rm(partial, { force: true }))
    return yield* fail("hash", file, "The file failed SHA-256 verification")
  }
  yield* Effect.tryPromise({
    try: () => rename(partial, destination),
    catch: (cause) => fail("io", file, "Could not move the verified file into place", cause)
  })
})
