import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { startServer } from "../src/index.js"

const modelHost = {
  models: [
    {
      id: "served",
      name: "Served",
      provider: { id: "p", name: "P" },
      reasoningEfforts: [],
      context: { hardLimit: 32_768, compactionTrigger: 26_214 }
    }
  ],
  defaults: {
    chatModelId: "served",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
}

describe("a chat model the server does not list", () => {
  it("is refused with the reason, on a new chat and on an existing one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-model-refusal-"))
    const server = await startServer({
      port: 0,
      databasePath: join(directory, "arden.db"),
      modelHost,
      sharedSkillRoots: []
    })
    const headers = { "content-type": "application/json" }
    try {
      const created = await server.fetch("/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ chat_model: "nope" })
      })
      const session = await server.fetch("/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({})
      })
      const { session_id } = (await session.json()) as { readonly session_id: string }
      const changed = await server.fetch(`/sessions/${session_id}/model`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ chat_model: "nope" })
      })
      expect([
        { status: created.status, body: await created.json() },
        { status: changed.status, body: await changed.json() }
      ]).toEqual([
        { status: 422, body: { detail: "Model nope is not available" } },
        { status: 422, body: { detail: "Model nope is not available" } }
      ])
    } finally {
      await server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
