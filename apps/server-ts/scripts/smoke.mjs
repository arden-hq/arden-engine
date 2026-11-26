import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HEALTH_STATUS_VALUE, healthDecoders } from "@arden-hq/protocol/health"
import { parseJsonText } from "@arden-hq/std/json-text"
import { startServer } from "../dist/index.js"

const managedOutputRoot = await mkdtemp(join(tmpdir(), "arden-smoke-"))
try {
  const server = await startServer({ port: 0, managedOutputRoot })
  try {
    const response = await server.fetch(new URL("/health", server.url))
    if (!response.ok) {
      throw new Error(`health check failed with HTTP ${response.status}`)
    }

    const health = healthDecoders.status(parseJsonText(await response.text()))
    if (health.status !== HEALTH_STATUS_VALUE.ok || health.hasProviders !== false) {
      throw new Error(`unexpected health response: ${JSON.stringify(health)}`)
    }

    process.stdout.write(`server smoke passed at ${server.url}\n`)
  } finally {
    await server.stop()
  }
} finally {
  await rm(managedOutputRoot, { recursive: true, force: true })
}
