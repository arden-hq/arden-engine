import { newChat } from "./fixtures/new-chat.js"
import { contextDecoders, contextRoutes } from "@arden-hq/protocol/context"
import { daemonDecoders, LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { permissionDecoders } from "@arden-hq/protocol/permissions"
import { Schema } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { offeredTools } from "../src/serve/apply.js"
import { readyLine, startConfigured } from "../src/serve/serve.js"
import { parseSettings, SettingsError } from "../src/serve/settings.js"
import { startServerWithLocalAccess } from "../src/server.js"

const catalog = [
  { name: "exec_command", source: "_local" },
  { name: "gmail_send", source: "gmail" },
  { name: "spawn_agent", source: null }
]

it("a settings file is refused with the reason when it cannot be applied", () => {
  const base = { dataDirectory: "/tmp/arden-settings" }
  expect(() => parseSettings({})).toThrow(SettingsError)
  expect(() => parseSettings({ ...base, dataDirectory: "relative" })).toThrow(/absolute/)
  expect(() => parseSettings({ ...base, stepLimit: 5 })).toThrow(SettingsError)
  expect(() =>
    parseSettings({ ...base, tools: [], blockedTools: { sources: [], tools: [] } })
  ).toThrow(/not both/)
  expect(() => parseSettings({ ...base, extraModels: ["b"] })).toThrow(/needs `model`/)
  expect(() => parseSettings({ ...base, model: "a", extraModels: ["a"] })).toThrow(/repeats/)
  expect(() =>
    parseSettings({
      ...base,
      provider: { kind: "responses", baseUrl: "http://127.0.0.1:9", apiKeyEnv: "KEY" }
    })
  ).toThrow(/needs `model` and `contextLimit`/)
  expect(() => parseSettings({ ...base, reasoningEffort: "high" })).toThrow(/needs `model`/)
  expect(() => parseSettings({ ...base, model: "a", helperModel: "b" })).toThrow(
    /must be `model` or one of `extraModels`/
  )
  expect(() => parseSettings({ ...base, approvalMode: "always" })).toThrow(SettingsError)
  expect(() =>
    parseSettings({
      ...base,
      model: "a",
      contextLimit: 1000,
      provider: { kind: "responses", baseUrl: "http://example.com", apiKeyEnv: "KEY" }
    })
  ).toThrow(/would send the key in clear text to example.com/)
  const withUrl = (baseUrl: string) => ({
    ...base,
    provider: { kind: "chat-completions", baseUrl }
  })
  expect(() => parseSettings(withUrl("http://127.0.0.1:8080/v1?key=secret"))).toThrow(/query/)
  expect(() => parseSettings(withUrl("http://127.0.0.1:8080/v1?"))).toThrow(/query/)
  expect(() => parseSettings(withUrl("http://127.0.0.1:8080/v1#models"))).toThrow(/fragment/)
  expect(() => parseSettings(withUrl("http://127.0.0.1:8080/v1#"))).toThrow(/fragment/)
  expect(parseSettings(withUrl("http://127.0.0.1:8080/v1"))).toEqual(
    withUrl("http://127.0.0.1:8080/v1")
  )
  expect(parseSettings(base)).toEqual(base)
})

it("a chat-completions provider needs only what its server does not report", () => {
  const base = { dataDirectory: "/tmp/arden-settings" }
  const provider = (fields: Record<string, string>) => ({
    ...base,
    provider: { kind: "chat-completions", baseUrl: "http://127.0.0.1:9931/v1", ...fields }
  })
  // llama.cpp lists its models and windows; an absent server is detected at start.
  expect(parseSettings(provider({ server: "llama.cpp" }))).toEqual(
    provider({ server: "llama.cpp" })
  )
  expect(parseSettings(provider({}))).toEqual(provider({}))
  expect(() => parseSettings(provider({ server: "openrouter" }))).toThrow(SettingsError)
  expect(parseSettings({ ...provider({ server: "openrouter" }), model: "m" })).toBeDefined()
  expect(() => parseSettings({ ...provider({ server: "generic" }), model: "m" })).toThrow(
    SettingsError
  )
  expect(() => parseSettings(provider({ server: "vllm" }))).toThrow(/server/)
})

it("plain HTTP goes to any host only when no key is sent: a key never crosses the network in clear text", () => {
  const settings = (baseUrl: string, fields: Record<string, string> = {}) => ({
    dataDirectory: "/tmp/arden-settings",
    provider: { kind: "chat-completions", baseUrl, ...fields }
  })
  // No key: a llama.cpp on the Docker host or on the LAN, with no setting.
  for (const url of ["http://host.docker.internal:8080/v1", "http://192.168.1.20:8080/v1"])
    expect(parseSettings(settings(url))).toEqual(settings(url))
  // A key goes only over HTTPS or to this machine.
  expect(() =>
    parseSettings(settings("http://192.168.1.20:8080/v1", { apiKeyEnv: "LLAMA_KEY" }))
  ).toThrow(SettingsError)
  // A `responses` provider always sends a key.
  expect(() =>
    parseSettings({
      dataDirectory: "/tmp/arden-settings",
      model: "m",
      contextLimit: 1000,
      provider: { kind: "responses", baseUrl: "http://192.168.1.20:8080/v1", apiKeyEnv: "KEY" }
    })
  ).toThrow(SettingsError)
  // Loopback HTTP and HTTPS take a key as before.
  for (const url of ["http://127.0.0.1:8080/v1", "https://llama.example/v1"])
    expect(parseSettings(settings(url, { apiKeyEnv: "KEY" }))).toEqual(
      settings(url, { apiKeyEnv: "KEY" })
    )
  // Another scheme is neither.
  expect(() => parseSettings(settings("ftp://10.0.0.2/v1"))).toThrow(SettingsError)
  expect(() => parseSettings(settings("ftp://10.0.0.2/v1", { apiKeyEnv: "KEY" }))).toThrow(
    SettingsError
  )
})

it("the offered tools are the allow-list, or the catalog minus the block-list", () => {
  expect(offeredTools({}, catalog)).toBeUndefined()
  expect([...(offeredTools({ tools: ["exec_command"] }, catalog) ?? [])]).toEqual(["exec_command"])
  expect([
    ...(offeredTools({ blockedTools: { sources: ["gmail"], tools: ["spawn_agent"] } }, catalog) ??
      [])
  ]).toEqual(["exec_command"])
  expect(() => offeredTools({ tools: ["missing"] }, catalog)).toThrow(/Unknown tool: missing/)
  expect(() =>
    offeredTools({ blockedTools: { sources: ["missing"], tools: [] } }, catalog)
  ).toThrow(/Unknown tool source: missing/)
})

it("a configured server refuses the owner's own data folder", async () => {
  await expect(
    startConfigured(
      parseSettings({ dataDirectory: join(homedir(), ".arden") }),
      startServerWithLocalAccess,
      {}
    )
  ).rejects.toThrow(/owner's own Arden folder/)
})

it("a configured server starts with its settings in place and publishes its access file", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-serve-"))
  const dataDirectory = join(root, "data")
  const workspace = join(root, "work")
  const configured = await startConfigured(
    parseSettings({
      dataDirectory,
      provider: { kind: "responses", baseUrl: "http://127.0.0.1:9", apiKeyEnv: "SERVE_TEST_KEY" },
      model: "test-model",
      contextLimit: 100_000,
      extraModels: ["small-model"],
      maxSteps: 40,
      tools: ["exec_command"],
      workspace,
      memory: false,
      automations: false,
      skillRoots: [],
      idleCompactionAfterMs: 0,
      helperModel: "small-model",
      approvalMode: "allow",
      compaction: { threshold: 0.6, summaryMaxTokens: 2000 }
    }),
    startServerWithLocalAccess,
    { SERVE_TEST_KEY: "not-a-real-key" }
  )
  try {
    expect(configured.applied.offeredTools).toEqual(["exec_command"])
    // The ready line says what a new chat runs on, in the shape its readers decode.
    expect(daemonDecoders.configuredServerReady(readyLine(configured))).toEqual({
      type: "ready",
      url: configured.server.url.href,
      dataDirectory,
      accessFile: join(dataDirectory, "cli-access.json"),
      usageFile: join(dataDirectory, "usage.json"),
      offeredTools: { kind: "listed", names: ["exec_command"] },
      toolsWithoutRule: configured.applied.toolsWithoutRule,
      mcpServers: [],
      provider: "responses",
      model: "test-model",
      contextWindow: 100_000
    })
    const access = daemonDecoders.cliAccess(
      JSON.parse(await readFile(configured.accessFile, "utf8"))
    )
    expect(configured.accessFile).toBe(join(dataDirectory, "cli-access.json"))
    expect(access.serverUrl).toBe(configured.server.url.href)
    expect(access.pid).toBe(process.pid)
    const headers = { "content-type": "application/json" }
    const get = async (path: string): Promise<unknown> => {
      const response = await configured.request(path, { headers })
      expect(response.status).toBe(200)
      return response.json()
    }
    // The published secret is the owner's: whoever started the server reaches
    // every route with it. Without a secret nothing answers.
    const published = { [LOCAL_CAPABILITY_HEADER]: access.capability }
    expect(
      (await configured.server.fetch("/settings/intelligence", { headers: published })).status
    ).toBe(200)
    expect((await configured.server.fetch("/sessions")).status).toBe(403)

    // Sub-agents are off because `spawn_agent` is not offered.
    expect(await get("/settings/intelligence")).toMatchObject({
      max_agent_depth: 1,
      max_concurrent_agents: 1,
      compaction_threshold: 0.6,
      summary_max_tokens: 2000
    })
    // Every Automation is off.
    const { automations } = Schema.decodeUnknownSync(
      Schema.Struct({ automations: Schema.Array(Schema.Struct({ enabled: Schema.Boolean })) })
    )(await get("/automations"))
    expect(automations.length).toBeGreaterThan(0)
    expect(automations.every((automation) => !automation.enabled)).toBe(true)
    // A new chat takes no Memory into its prompt.
    const created = await configured.request("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(newChat({ name: "Configured" }))
    })
    const session = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }))(
      await created.json()
    )
    expect(
      contextDecoders.experiments(await get(contextRoutes.experiments(session.session_id)))
        .selection
    ).toMatchObject({ memory: false, threads: false, skills: true })
  } finally {
    await configured.stop()
    await expect(readFile(configured.accessFile, "utf8")).rejects.toThrow()
  }
  // A second start on the same data folder applies the file again: what
  // changed is changed, and nothing is added twice.
  const again = await startConfigured(
    parseSettings({
      dataDirectory,
      provider: { kind: "responses", baseUrl: "http://127.0.0.1:9", apiKeyEnv: "SERVE_TEST_KEY" },
      model: "test-model",
      contextLimit: 100_000,
      tools: ["exec_command", "spawn_agent"],
      subAgents: { maxConcurrent: 2 },
      workspace
    }),
    startServerWithLocalAccess,
    { SERVE_TEST_KEY: "not-a-real-key" }
  )
  try {
    expect(again.applied.offeredTools).toEqual(["exec_command", "spawn_agent"])
    const response = await again.request("/permissions/rules")
    const { rules } = permissionDecoders.rules(await response.json())
    const forTool = (tool: string) =>
      rules.filter((entry) => entry.subject.kind === "tool" && entry.subject.tool === tool)
    expect(forTool("spawn_agent").map((entry) => entry.decision)).toEqual(["allow"])
    expect(forTool("exec_command").map((entry) => entry.decision)).toEqual(["allow"])
    // Sub-agents are back on, with the file's limit and the default depth.
    const settings = await again.request("/settings/intelligence")
    expect(await settings.json()).toMatchObject({ max_agent_depth: 3, max_concurrent_agents: 2 })
  } finally {
    await again.stop()
    await rm(root, { recursive: true, force: true })
  }
})
