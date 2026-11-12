import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { startServer, type ServerHandle } from "../src/index.js"
import { brokeredProviderRoute, type BrokerCredential } from "../src/providers/registry.js"

// Reading chats needs no model credential. The desktop host can take seconds
// to fetch one, so the server must open and serve reads while it is pending.
it(
  "opens and serves reads while the model credential is still pending",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-pending-credential-"))
    const pending = new Promise<BrokerCredential | null>(() => {})
    const provider = brokeredProviderRoute.start(
      { initial: pending, request: () => pending },
      "0.0.0-test"
    )
    let server: ServerHandle | undefined
    try {
      server = await startServer({
        port: 0,
        databasePath: join(directory, "arden.db"),
        ...provider
      })
      const created = await server.fetch("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Pending" })
      })
      expect(created.ok).toBe(true)
      const listed = await server.fetch("/sessions")
      expect(listed.ok).toBe(true)
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
