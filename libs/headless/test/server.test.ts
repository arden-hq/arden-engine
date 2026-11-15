import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ConfiguredServerError, startConfiguredServer } from "../src/index.js"

// Each entry is a real process standing in for the server's `main.js --config`:
// it prints what the server prints, so the reader is tested on the real pipe.
const CAPABILITY = "c".repeat(43)

let directory = ""
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "arden-headless-server-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const entry = async (name: string, body: string): Promise<string> => {
  const path = join(directory, name)
  await writeFile(path, body)
  return path
}

describe("startConfiguredServer", () => {
  it("reads the ready line and the server's own access file, and stops it", async () => {
    const accessFile = join(directory, "cli-access.json")
    const ready = {
      type: "ready",
      url: "http://127.0.0.1:51234/",
      dataDirectory: directory,
      accessFile,
      usageFile: join(directory, "usage.json"),
      toolsWithoutRule: ["drive_upload"],
      mcpServers: []
    }
    const server = await startConfiguredServer({
      entry: await entry(
        "ready.mjs",
        `import { writeFileSync } from "node:fs"
         if (process.argv[2] !== "--config" || process.argv[3] !== "settings.json") process.exit(9)
         writeFileSync(${JSON.stringify(accessFile)}, JSON.stringify({ version: 1, serverUrl: "http://127.0.0.1:51234/", capability: "${CAPABILITY}", pid: process.pid }))
         console.error("log line")
         console.log(${JSON.stringify(JSON.stringify(ready))})
         setInterval(() => {}, 1000)`
      ),
      config: "settings.json",
      env: { PATH: process.env["PATH"] }
    })
    expect({ ready: server.ready, connection: server.connection }).toEqual({
      ready: {
        url: ready.url,
        dataDirectory: directory,
        accessFile,
        usageFile: ready.usageFile,
        offeredTools: undefined,
        toolsWithoutRule: ["drive_upload"],
        mcpServers: []
      },
      connection: {
        url: new URL(ready.url),
        headers: { "x-arden-local-capability": CAPABILITY }
      }
    })
    await server.stop()
  })

  it("rejects with the server's own reason, a settings mistake apart from a failed start", async () => {
    const log: Array<string> = []
    const settings = startConfiguredServer({
      entry: await entry(
        "settings.mjs",
        `console.error("arden: Cannot reach http://127.0.0.1:9/v1/props: fetch failed")
         process.exit(2)`
      ),
      config: "settings.json",
      env: {},
      onLog: (chunk) => log.push(chunk)
    })
    await expect(settings).rejects.toEqual(
      new ConfiguredServerError(
        "settings",
        "Cannot reach http://127.0.0.1:9/v1/props: fetch failed"
      )
    )
    await expect(settings).rejects.toMatchObject({ reason: "settings" })
    expect(log.join("")).toBe("arden: Cannot reach http://127.0.0.1:9/v1/props: fetch failed\n")

    const crashed = startConfiguredServer({
      entry: await entry("crash.mjs", "process.exit(1)"),
      config: "settings.json",
      env: {}
    })
    await expect(crashed).rejects.toMatchObject({
      reason: "start",
      message: "The Arden server exited with code 1"
    })
  })
})
