import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../dist/index.js"

const managedOutputRoot = await mkdtemp(join(tmpdir(), "arden-smoke-"))
try {
  const server = await startServer({ port: 0, managedOutputRoot })
  try {
    const response = await server.fetch(new URL("/health", server.url))
    if (!response.ok) {
      throw new Error(`health check failed with HTTP ${response.status}`)
    }

    const health = await response.json()
    if (health.status !== "ok" || health.has_providers !== false) {
      throw new Error(`unexpected health response: ${JSON.stringify(health)}`)
    }

    process.stdout.write(`server smoke passed at ${server.url}\n`)
  } finally {
    await server.stop()
  }
} finally {
  await rm(managedOutputRoot, { recursive: true, force: true })
}
