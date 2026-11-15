import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { modelSettings, readProfile } from "../profile.mjs"
import { parseSettings } from "../../apps/server-ts/dist/serve/settings.js"

const base = {
  name: "openrouter",
  provider: "chat-completions",
  server: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  model: "vendor/model",
  reasoningEffort: null,
  contextLimit: 131072,
  timeoutMs: 60000,
  maxModelRequests: 10,
  tools: ["exec_command"],
  memory: false
}

test("a chat-completions profile becomes the settings Arden starts with", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-profile-"))
  const file = (name) => join(directory, name)
  try {
    await writeFile(file("profile.json"), JSON.stringify(base))
    const settings = modelSettings(await readProfile(file("profile.json")))
    assert.deepEqual(settings, {
      provider: {
        kind: "chat-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        server: "openrouter"
      },
      model: "vendor/model",
      contextLimit: 131072
    })
    assert.equal(
      parseSettings({ dataDirectory: directory, ...settings }).provider?.kind,
      "chat-completions"
    )
    await writeFile(file("codex.json"), JSON.stringify({ ...base, provider: "codex" }))
    await assert.rejects(readProfile(file("codex.json")), /`server` belongs to a chat-completions/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
