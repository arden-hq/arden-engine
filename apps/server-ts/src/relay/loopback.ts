import { SSE_FRAME_ID, decodeSseFrameStream } from "@arden-hq/protocol"
import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { Option, Predicate, Schema } from "effect"
import type { HttpServer } from "effect/unstable/http"
import type { LocalAccess } from "../http/middleware/local-only.js"
import type { Loopback } from "./ports.js"

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const parseBody = (text: string): Schema.Json =>
  text === "" ? null : Option.getOrElse(decodeBody(text), () => null)

export const relayLoopback = (
  address: HttpServer.Address,
  access: LocalAccess | undefined
): Loopback => {
  const base = Predicate.isTagged(address, "TcpAddress")
    ? `http://127.0.0.1:${address.port}`
    : "http://127.0.0.1"
  const auth: Record<string, string> =
    access === undefined ? {} : { [LOCAL_CAPABILITY_HEADER]: access.phoneCapability }
  return {
    request: async ({ method, path, body, signal }) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal })
      })
      return { status: response.status, body: parseBody(await response.text()) }
    },
    events: async function* ({ path, lastEventId, signal }) {
      const response = await fetch(`${base}${path}`, {
        headers: {
          ...auth,
          accept: "text/event-stream",
          ...(lastEventId.kind === SSE_FRAME_ID.identified
            ? { "last-event-id": lastEventId.id }
            : {})
        },
        signal
      })
      if (!response.ok || response.body === null)
        throw new Error(`The event stream answered ${response.status}`)
      for await (const frame of decodeSseFrameStream(response.body)) {
        yield { id: frame.id, data: frame.data }
      }
    }
  }
}
