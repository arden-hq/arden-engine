import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpApi } from "effect/unstable/httpapi"
import { expect, it } from "vitest"
import { ArdenApi } from "../../src/http/api.js"
import { startServer, type ServerHandle } from "../../src/index.js"

// The scan check sees only statements that some test runs. Screens read
// through GET routes, and many had no test, so their queries were never
// planned. This calls every GET route the API declares, on an empty database:
// a query's plan does not depend on the rows, so one call is enough for the
// check to see it. A new route is covered the day it is added.
//
// Jobs on a timer (log trim, file cleanup, stranded-run sweep) start minutes
// after launch. ARDEN_TIMERS_AT_ONCE makes each run within a quarter second,
// so the check sees their queries too.
it(
  "every GET route runs once, so the scan check plans its queries",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-route-sweep-"))
    let server: ServerHandle | undefined
    process.env["ARDEN_TIMERS_AT_ONCE"] = "1"
    try {
      server = await startServer({ port: 0, databasePath: join(directory, "arden.db") })
      const created = await server.fetch("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Sweep" })
      })
      const session = (await created.json()) as { readonly session_id: string }
      const routes: Array<string> = []
      HttpApi.reflect(ArdenApi, {
        onGroup: () => undefined,
        onEndpoint: ({ endpoint }) => {
          if (endpoint.method === "GET") routes.push(endpoint.path)
        }
      })
      expect(routes.length).toBeGreaterThan(50)
      const answered: Array<string> = []
      for (const route of routes) {
        const path = route.replace(/:[A-Za-z_]+/g, session.session_id)
        for (const url of [path, `${path}?session_id=${session.session_id}`]) {
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(), 3_000)
          try {
            const response = await server.fetch(url, { signal: abort.signal })
            // An event stream never ends: its first frame is enough.
            await response.body?.getReader().read()
            answered.push(route)
          } catch {
            // A route that needs more input, or a stream cut by the timer.
          } finally {
            clearTimeout(timer)
            abort.abort()
          }
        }
      }
      expect(new Set(answered).size).toBeGreaterThan(50)
    } finally {
      delete process.env["ARDEN_TIMERS_AT_ONCE"]
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
