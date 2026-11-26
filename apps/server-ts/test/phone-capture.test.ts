import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { mobileDecoders, mobileRoutes } from "@arden-hq/protocol/mobile"
import {
  sessionDecoders,
  sessionRequests,
  sessionRoutes,
  spaceIdOf
} from "@arden-hq/protocol/sessions"
import { spaceDecoders, spaceRequests, spaceRoutes } from "@arden-hq/protocol/spaces"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { runCommand } from "../src/relay/commands.js"
import { relayLoopback } from "../src/relay/loopback.js"
import type { Loopback } from "../src/relay/ports.js"
import { startServerWithLocalAccess, type ServerHandle } from "../src/server.js"
import { messageInput } from "./fixtures/chat-requests.js"
import { newChat } from "./fixtures/new-chat.js"
import { openTurn } from "./fixtures/work-arrivals.js"
import { present } from "./kit.js"

const access = {
  host: "app" as const,
  capability: "desktop-secret-0000000000000000000000",
  rendererOrigin: "http://127.0.0.1",
  cliCapability: "command-line-secret-00000000000000000",
  phoneCapability: "phone-secret-0000000000000000000000000"
}

const headers = { [LOCAL_CAPABILITY_HEADER]: access.capability, "content-type": "application/json" }
const captureResult = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }))

const withPhone = async (test: (server: ServerHandle, phone: Loopback) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "arden-phone-capture-"))
  try {
    const server = await startServerWithLocalAccess({
      port: 0,
      databasePath: join(directory, "arden.db"),
      localAccess: access,
      runner: openTurn,
      memory: false,
      sharedSkillRoots: []
    })
    try {
      await test(
        server,
        relayLoopback({ _tag: "TcpAddress", hostname: "127.0.0.1", port: server.port }, access)
      )
    } finally {
      await server.stop()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const createSpace = async (server: ServerHandle, name: string) => {
  const response = await server.fetch(spaceRoutes.collection, {
    method: "POST",
    headers,
    body: spaceRequests.create({ name, instructions: { kind: "unwritten" } })
  })
  return spaceDecoders.space(await response.json()).space_id
}

it("starts ordinary chats from phone captures in Main and in the selected Space", async () => {
  await withPhone(async (server, phone) => {
    const spaces = spaceDecoders.list(
      await (await server.fetch(spaceRoutes.collection, { headers })).json()
    )
    const main = present(
      spaces.spaces.find((space) => space.kind === "main"),
      "Main Space"
    )
    const spaceId = await createSpace(server, "Project")
    for (const [target, expected] of [
      [null, main.space_id],
      [spaceId, spaceId]
    ] as const) {
      const text = `A note for ${expected}`
      const clientId = `capture-${expected}`
      const outcome = await runCommand(phone, clientId, {
        kind: "capture",
        args: { text, space_id: target }
      })
      expect(outcome).toEqual({ state: "done", result: { session_id: expect.any(String) } })
      const { session_id: sessionId } = captureResult(outcome.result)
      const list = sessionRoutes.list({
        scope: "primary",
        live: false,
        limit: 1,
        sort: "activity",
        filter: { kind: "sessions", session_ids: [sessionId] },
        page: { kind: "first" }
      })
      const { sessions } = sessionDecoders.listResponse(
        await (await server.fetch(list, { headers })).json()
      )
      const session = present(
        sessions.find((row) => row.session_id === sessionId),
        "the captured chat"
      )
      expect({ origin: session.origin, space: spaceIdOf(session.space) }).toEqual({
        origin: "ordinary",
        space: expected
      })
      const history = chatDecoders.history(
        await (
          await server.fetch(
            chatRoutes.history({ sessionId, limit: 10, window: { kind: "latest" } }),
            { headers }
          )
        ).json()
      )
      expect(history.messages.find((message) => message.role === ROLE.user)).toMatchObject({
        content: text,
        client: { kind: "tracked", client_id: clientId }
      })
    }
  })
})

it("reports active work on the phone for the Space that owns the running chat", async () => {
  await withPhone(async (server, phone) => {
    const working = await createSpace(server, "Project")
    const quiet = await createSpace(server, "Quiet")
    const created = await server.fetch(sessionRoutes.collection, {
      method: "POST",
      headers,
      body: sessionRequests.create(newChat({ spaceId: working }))
    })
    const session = sessionDecoders.createResponse(await created.json())
    const sent = await server.fetch(chatRoutes.message, {
      method: "POST",
      headers,
      body: chatRequests.message(messageInput(session.session_id, "Start work")).body
    })
    expect(sent.status).toBe(200)
    const response = await phone.request({ method: "GET", path: mobileRoutes.spaces })
    expect(response.status).toBe(200)
    const { spaces } = mobileDecoders.spaces(response.body)
    expect(
      [working, quiet].map((id) => spaces.find((space) => space.id === id)?.state_line)
    ).toEqual([
      { tone: "working", text: "", more: 0 },
      { tone: "quiet", text: "", more: 0 }
    ])
  })
})
