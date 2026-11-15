import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { modelSettings, readProfile } from "../profile.mjs"

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

const withProfiles = async (check) => {
  const directory = await mkdtemp(join(tmpdir(), "arden-profile-"))
  const read = async (name, profile) => {
    await writeFile(join(directory, name), JSON.stringify(profile))
    return readProfile(join(directory, name))
  }
  try {
    await check(read, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("a chat-completions profile becomes the settings Arden starts with", () =>
  withProfiles(async (read) => {
    assert.deepEqual(modelSettings(await read("openrouter.json", base)), {
      provider: {
        kind: "chat-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        server: "openrouter"
      },
      model: "vendor/model",
      contextLimit: 131072
    })
    await assert.rejects(
      read("codex.json", { ...base, provider: "codex" }),
      /`server` belongs to a chat-completions/
    )
  }))

test("a local llama.cpp profile names no key; every other provider needs one", () =>
  withProfiles(async (read, directory) => {
    const { apiKeyEnv: _, ...local } = {
      ...base,
      server: "llama.cpp",
      baseUrl: "http://127.0.0.1:8080/v1"
    }
    assert.deepEqual(modelSettings(await read("llama.json", local)), {
      provider: {
        kind: "chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        server: "llama.cpp"
      },
      model: "vendor/model",
      contextLimit: 131072
    })
    const { provider: _kind, server: _server, ...responses } = local
    await assert.rejects(read("responses.json", responses), {
      message: `Profile ${join(directory, "responses.json")}: Invalid settings: Expected string at ["provider"]["apiKeyEnv"]`
    })
    // A container reaching the host's server by name is plain HTTP off this machine.
    await assert.rejects(
      read("docker.json", { ...local, baseUrl: "http://host.docker.internal:8080/v1" }),
      /`provider.baseUrl` must use HTTPS or loopback HTTP\. .*add "insecureHttpHost": "host.docker.internal"/
    )
  }))

test("a container profile opts into plain HTTP to the host it names, with no key", () =>
  withProfiles(async (read) => {
    const { apiKeyEnv: _, ...docker } = {
      ...base,
      server: "llama.cpp",
      baseUrl: "http://host.docker.internal:8080/v1",
      insecureHttpHost: "host.docker.internal"
    }
    assert.deepEqual(modelSettings(await read("docker.json", docker)), {
      provider: {
        kind: "chat-completions",
        baseUrl: "http://host.docker.internal:8080/v1",
        server: "llama.cpp",
        insecureHttpHost: "host.docker.internal"
      },
      model: "vendor/model",
      contextLimit: 131072
    })
    await assert.rejects(
      read("other-host.json", { ...docker, baseUrl: "http://10.0.0.2:8080/v1" }),
      /`provider.insecureHttpHost` is host.docker.internal, but `provider.baseUrl` goes to 10.0.0.2/
    )
    await assert.rejects(
      read("keyed.json", { ...docker, apiKeyEnv: "LLAMA_KEY" }),
      /`provider.apiKeyEnv` would send the key in clear text to host.docker.internal/
    )
  }))

test("every example profile reads once its model is chosen", () =>
  withProfiles(async (read) => {
    const folder = resolve(import.meta.dirname, "../profiles")
    const names = (await readdir(folder)).filter(
      (name) => name.endsWith(".json") && !name.startsWith("local-")
    )
    for (const name of names) {
      const profile = JSON.parse(await readFile(join(folder, name), "utf8"))
      await assert.rejects(read(name, profile), /Choose a model before running/)
      await read(name, { ...profile, model: "chosen/model" })
    }
  }))
