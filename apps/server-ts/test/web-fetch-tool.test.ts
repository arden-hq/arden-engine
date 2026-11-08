import type { ToolContext } from "@arden-hq/loop"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { ServerRunContext } from "../src/tools/run-context.js"
import { webFetchTools } from "../src/tools/web-fetch.js"
import { serverRunContext } from "./kit.js"

const [webFetch] = Effect.runSync(webFetchTools)

const context = (): ToolContext<ServerRunContext> => ({
  toolCallId: "call-web-fetch",
  signal: new AbortController().signal,
  run: serverRunContext({ sessionId: "session-web-fetch", runId: "run-web-fetch" }),
  messages: []
})

const fetchUrl = (url: string) => {
  if (webFetch === undefined) throw new Error("web_fetch is not registered")
  return webFetch.execute({ url }, context())
}

let server: Server
let requests = 0
let origin = ""

beforeEach(async () => {
  requests = 0
  server = createServer((_request, response) => {
    requests += 1
    response.end("secret admin page")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe("web_fetch refuses the local network", () => {
  it("never sends a request to a loopback server, by address or by name", async () => {
    await expect(fetchUrl(`${origin}/admin`)).rejects.toMatchObject({
      preview: "Private address blocked",
      retryable: false
    })
    await expect(fetchUrl(origin.replace("127.0.0.1", "localhost"))).rejects.toMatchObject({
      preview: "Private host blocked",
      retryable: false
    })
    expect(requests).toBe(0)
  })

  it.each([
    "http://10.0.0.7/page",
    "http://192.168.1.1/page",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/page",
    "https://[2001:db8::1]/documentation",
    "https://[3fff::1]/documentation"
  ])("refuses the private or reserved address in %s", async (url) => {
    await expect(fetchUrl(url)).rejects.toMatchObject({
      preview: "Private address blocked",
      retryable: false
    })
  })

  it("refuses a URL that carries credentials before resolving its host", async () => {
    await expect(fetchUrl("https://user:secret@example.com/private")).rejects.toMatchObject({
      preview: "Credential URL blocked",
      retryable: false
    })
  })
})
