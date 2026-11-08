import { createServer, type ServerResponse } from "node:http"

const LOOPBACK_HOST = "127.0.0.1"

export interface LoopbackReply {
  readonly status: number
  readonly type: "html" | "text"
  readonly body: string
}

export interface LoopbackRequest {
  readonly method: string | undefined
  readonly params: URLSearchParams
}

export interface LoopbackListener {
  readonly redirectUri: string
  readonly close: () => Promise<void>
}

const NOT_FOUND: LoopbackReply = { status: 404, type: "text", body: "Not found" }

const CONTENT_TYPES: Record<LoopbackReply["type"], string> = {
  html: "text/html; charset=utf-8",
  text: "text/plain; charset=utf-8"
}

const write = (response: ServerResponse, reply: LoopbackReply): void => {
  response.writeHead(reply.status, { "content-type": CONTENT_TYPES[reply.type] }).end(reply.body)
}

export const loopbackRedirectUri = (port: number, path: string): string =>
  `http://${LOOPBACK_HOST}:${port}${path}`

/**
 * One OAuth redirect listener on the loopback interface. `port: "ephemeral"`
 * lets the OS pick one per flow (a desktop client accepts any loopback port);
 * a fixed port keeps a redirect URI that was registered once. Requests off
 * `path` get 404; every other request is answered by `respond`. `onError`
 * sees every server error, including a failed listen, which also rejects.
 * Lifetime (timeouts, one flow or many) belongs to the caller.
 */
export const listenLoopback = async ({
  port,
  path,
  respond,
  onError
}: {
  readonly port: number | "ephemeral"
  readonly path: string
  readonly respond: (request: LoopbackRequest) => LoopbackReply | Promise<LoopbackReply>
  readonly onError?: (cause: Error) => void
}): Promise<LoopbackListener> => {
  const base = loopbackRedirectUri(port === "ephemeral" ? 0 : port, path)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base)
    if (url.pathname !== path) {
      write(response, NOT_FOUND)
      return
    }
    void (async () => {
      write(response, await respond({ method: request.method, params: url.searchParams }))
    })()
  })
  if (onError !== undefined) server.on("error", onError)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port === "ephemeral" ? 0 : port, LOOPBACK_HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const close = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") {
    await close()
    throw new Error("Loopback callback could not start")
  }
  return { redirectUri: loopbackRedirectUri(address.port, path), close }
}
