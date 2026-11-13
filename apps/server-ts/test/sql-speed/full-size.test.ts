import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { HttpApi } from "effect/unstable/httpapi"
import { expect, it } from "vitest"
import { ArdenApi } from "../../src/http/api.js"
import { startServer, type ServerHandle } from "../../src/index.js"
import { BREAKDOWN_QUERIES } from "../../src/persistence/sqlite/storage-breakdown-queries.js"
import { seedFullSizeDatabase, type FullSizeIds } from "../fixtures/full-size-database.js"

// The scan check (test/sql-scans) fails a statement whose plan reads a whole
// growing table, and it judges plans on an empty database. A statement can
// use an index and still read thousands of rows: the newest run of one
// Automation among its 3,500, every completed run through a status index.
// Only rows show that, and a time budget cannot: on a file just written every
// page is in memory, so such a statement takes milliseconds here and seconds
// on an old database after a restart.
//
// So this judges growth. It fills one database to about the owner's size and
// one with four times the history (test/fixtures/full-size-database.ts),
// opens every screen with ids that exist and lets every timer job run on
// each, and compares each distinct statement's fastest time at the two
// sizes. A statement whose work is bounded (one chat's messages, a LIMIT an
// index serves) takes the same time at both; one that reads more rows as the
// history grows takes longer. Times are noisy, so each size runs the sweep on
// two server starts and a statement is judged by its fastest run.

/** The large database holds this many times the history of the first. */
const LARGE_SCALE = 4
/** A statement fails when its fastest time at the large size is at least this... */
const GROWTH_FLOOR_MS = 5
/** ...and at least this many times its fastest time at the owner's size. */
const GROWTH_RATIO = 2
/** First-run times at or over this are listed in the report (not judged). */
const FIRST_RUN_REPORT_MS = 50
const MEASURED_STARTS = 2
/** After the routes, how long the timer jobs (ARDEN_TIMERS_AT_ONCE) get to run. */
const TIMER_JOBS_MS = 6_000
/** A route that streams is read until its first frame or this long. */
const ROUTE_TIMEOUT_MS = 3_000

/**
 * Statements allowed to grow, each with its reason. Two kinds belong here:
 * one-time work (a migration, a backfill's first fill), and an exception the
 * owner approved, with the date. A statement that grows with the history is
 * fixed, not listed.
 */
const ALLOWED_TO_GROW: ReadonlyArray<{ readonly sql: string; readonly reason: string }> = [
  {
    sql: BREAKDOWN_QUERIES.others,
    reason:
      "Owner-approved exception, 2026-11-13. The Storage page measures the size of the " +
      "tables outside chat data page by page (dbstat), so it grows with the file by nature. " +
      "It runs only when the owner opens Settings -> Storage or acts on that page (not at " +
      "launch, not on a timer, not on chat open)."
  }
]

/**
 * Routes whose id names something this database does not hold; each is still
 * called, with an id that does not exist, so its other queries run.
 */
const NO_REAL_ID: Readonly<Record<string, string>> = {
  "/skills/:name/content": "skills are files in the data folder, not rows",
  "/scripts/:workflowRef": "no code-mode script is seeded",
  "/browser-procedures/:id": "no learned browser procedure is seeded",
  "/proposals/:proposalId/history": "no Task proposal is seeded",
  "/proposals/:proposalId/recheck": "no Task proposal is seeded",
  "/spaces/:spaceId/focus-choices/:questionId": "no focus question is seeded",
  "/spaces/work/attachments/:attachmentId": "no Task attachment is seeded",
  "/sessions/:sessionId/visualizations/:artifactRef": "visualizations are files, none is seeded",
  "/sessions/:sessionId/visualizations/:artifactRef/content":
    "visualizations are files, none is seeded",
  "/admin/wiki/pages/:pageId": "wiki pages are files, none is seeded",
  "/admin/wiki/pages/:pageId/history": "wiki pages are files, none is seeded",
  "/admin/wiki/pages/:pageId/diff": "wiki pages are files, none is seeded",
  "/admin/wiki/pages/:pageId/versions/diff": "wiki pages are files, none is seeded",
  "/admin/wiki/pages/:pageId/links": "wiki pages are files, none is seeded",
  "/sessions/:sessionId/terminals/:terminalId/output": "terminals live in memory, none is open"
}

const MISSING = "not-seeded"

/** Routes that reach a service outside Arden (GitHub, the skills marketplace,
 * Google, the keychain); their answer depends on the machine, not the data. */
const OUTSIDE: ReadonlySet<string> = new Set([
  "/mcp/github",
  "/skills/marketplace/popular",
  "/skills/marketplace/search",
  "/google/accounts"
])

/** The warm-up's search waits this long for the index to catch up. */
const SEARCH_CATCH_UP_MS = 180_000

/** Every GET route with the calls that open it on the seeded data. */
const routeCalls = (
  ids: FullSizeIds,
  since: string,
  longAgo: string
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const chats = [ids.chat, ids.fork, ids.agent, ids.channel, ids.thread]
  const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`
  return {
    "/computer/setup": ["/computer/setup"],
    "/computer/preview": ["/computer/preview"],
    "/computer": ["/computer"],
    "/health": ["/health"],
    "/models": ["/models"],
    "/config": ["/config"],
    "/tools": ["/tools"],
    "/permissions/sessions/:sessionId": chats.map((id) => `/permissions/sessions/${id}`),
    "/permissions/default-mode": ["/permissions/default-mode"],
    "/permissions/rules": ["/permissions/rules"],
    "/permissions/rules/spaces/:spaceId": [`/permissions/rules/spaces/${ids.space}`],
    "/permissions/command-sandbox": ["/permissions/command-sandbox"],
    "/mcp/presets": ["/mcp/presets"],
    "/mcp/servers": ["/mcp/servers"],
    "/mcp/offers/:sessionId": [`/mcp/offers/${ids.chat}`],
    "/mcp/github": ["/mcp/github"],
    "/google/accounts": ["/google/accounts"],
    "/skills": ["/skills"],
    "/skills/marketplace/popular": ["/skills/marketplace/popular"],
    "/skills/marketplace/search": [`/skills/marketplace/search${q({ q: "pdf" })}`],
    "/skills/:name/content": [`/skills/${MISSING}/content`],
    "/storage/backfills": ["/storage/backfills"],
    "/storage/files": ["/storage/files"],
    "/storage/retention": ["/storage/retention"],
    "/storage": ["/storage"],
    "/context/experiments/:sessionId": [`/context/experiments/${ids.chat}`],
    "/settings/intelligence": ["/settings/intelligence"],
    "/settings/limits": ["/settings/limits"],
    "/embeddings/status": ["/embeddings/status"],
    "/local-models": ["/local-models"],
    "/model-endpoints": ["/model-endpoints"],
    "/decisions/status": ["/decisions/status"],
    "/session/history": chats.map((id) => `/session/history${q({ session_id: id })}`),
    "/session/turn-work": [
      `/session/turn-work${q({ session_id: ids.chat, turn_id: ids.chatTurn })}`
    ],
    "/session/turn-details": [
      `/session/turn-details${q({ session_id: ids.chat, turn_id: ids.chatTurn })}`
    ],
    "/session/tool-call": [
      `/session/tool-call${q({ session_id: ids.chat, turn_id: ids.chatTurn, tool_call_id: ids.chatToolCall })}`
    ],
    "/sessions/:sessionId/tool-results/:toolCallId": [
      `/sessions/${ids.chat}/tool-results/${ids.chatToolCall}`
    ],
    "/chat/events/:sessionId": [`/chat/events/${ids.chat}`, `/chat/events/${ids.fork}`],
    "/sessions/:sessionId/queue": [`/sessions/${ids.chat}/queue`],
    "/chat/runs/status": ["/chat/runs/status"],
    "/chat/runs/:runId": [ids.chatRun, ids.forkRun, ids.agentRun].map((id) => `/chat/runs/${id}`),
    "/chat/runs/:runId/progress": [ids.chatRun, ids.forkRun].map(
      (id) => `/chat/runs/${id}/progress`
    ),
    "/chat/runs/:runId/events": [`/chat/runs/${ids.chatRun}/events${q({ after_sequence: "0" })}`],
    "/usage/limits": ["/usage/limits"],
    "/usage": ["/usage", `/usage${q({ days: "30" })}`, `/usage${q({ days: "150" })}`],
    "/usage/sessions/:sessionId": [`/usage/sessions/${ids.chat}`, `/usage/sessions/${ids.thread}`],
    "/scripts/:workflowRef": [`/scripts/${MISSING}${q({ session_id: ids.chat })}`],
    "/browser-procedures": ["/browser-procedures"],
    "/browser-procedures/:id": [`/browser-procedures/${MISSING}`],
    "/automations/:taskId/configuration-history": [
      `/automations/${ids.busyAutomation}/configuration-history`
    ],
    "/automations": ["/automations"],
    "/automations/event-catalog": ["/automations/event-catalog"],
    "/automations/:taskId": [ids.busyAutomation, ids.freshAutomation].map(
      (id) => `/automations/${id}`
    ),
    "/automations/:taskId/runs": [ids.busyAutomation, ids.freshAutomation].map(
      (id) => `/automations/${id}/runs`
    ),
    "/automations/events": [`/automations/events${q({ after_seq: "0" })}`],
    "/spaces/:spaceId/history": [`/spaces/${ids.space}/history`],
    "/spaces/:spaceId/overview-history": [`/spaces/${ids.space}/overview-history`],
    "/spaces": ["/spaces"],
    "/spaces/overview": ["/spaces/overview"],
    "/spaces/archived": ["/spaces/archived"],
    "/spaces/:spaceId": [`/spaces/${ids.space}`],
    "/spaces/:spaceId/continuity/state": [`/spaces/${ids.space}/continuity/state`],
    "/proposals/:proposalId/history": [`/proposals/${MISSING}/history`],
    "/proposals": [
      `/proposals${q({ place: "home" })}`,
      `/proposals${q({ place: "space", space_id: ids.space })}`,
      `/proposals${q({ place: "chat", session_id: ids.chat })}`
    ],
    "/proposals/:proposalId/recheck": [`/proposals/${MISSING}/recheck`],
    "/spaces/:spaceId/focus-choices/:questionId": [`/spaces/${ids.space}/focus-choices/${MISSING}`],
    "/sessions/:sessionId/answer-blocks": [`/sessions/${ids.chat}/answer-blocks`],
    "/spaces/work/:itemId/history": [`/spaces/work/${ids.taskItem}/history`],
    "/home/letter": ["/home/letter"],
    "/home/evidence": [`/home/evidence${q({ since })}`, `/home/evidence${q({ since: longAgo })}`],
    "/spaces/work/:itemId/attempts": [`/spaces/work/${ids.taskItem}/attempts`],
    "/chat/questions": [
      "/chat/questions",
      `/chat/questions${q({ space_id: ids.space })}`,
      `/chat/questions${q({ session_id: ids.chat })}`,
      `/chat/questions${q({ state: "all" })}`
    ],
    "/spaces/work/attachments/:attachmentId": [`/spaces/work/attachments/1`],
    "/spaces/work/all": [
      "/spaces/work/all",
      `/spaces/work/all${q({ space_id: ids.space })}`,
      `/spaces/work/all${q({ session_id: ids.chat })}`
    ],
    "/sessions/:sessionId/configuration-history": [`/sessions/${ids.chat}/configuration-history`],
    "/sessions": [
      "/sessions",
      `/sessions${q({ scope: "all" })}`,
      `/sessions${q({ scope: "agent" })}`,
      `/sessions${q({ inbox: "true" })}`,
      `/sessions${q({ live: "true" })}`,
      `/sessions${q({ sort: "accessed" })}`,
      `/sessions${q({ space_id: ids.space })}`,
      `/sessions${q({ parent_session_ids: ids.chat })}`,
      `/sessions${q({ session_ref: `ref-${ids.chat}` })}`
    ],
    "/sessions/:sessionId/export": [
      `/sessions/${ids.chat}/export${q({ format: "markdown" })}`,
      `/sessions/${ids.chat}/export${q({ format: "archive" })}`
    ],
    "/sessions/:sessionId/find": [`/sessions/${ids.chat}/find${q({ q: "item" })}`],
    "/sessions/search": [
      `/sessions/search${q({ q: "item" })}`,
      `/sessions/search${q({ q: "nothing-matches" })}`
    ],
    "/sessions/:sessionId/visualizations": [`/sessions/${ids.chat}/visualizations`],
    "/sessions/:sessionId/visualizations/:artifactRef": [
      `/sessions/${ids.chat}/visualizations/${MISSING}`
    ],
    "/sessions/:sessionId/visualizations/:artifactRef/content": [
      `/sessions/${ids.chat}/visualizations/${MISSING}/content`
    ],
    "/sessions/archived": ["/sessions/archived"],
    "/sessions/:sessionId/todo": [`/sessions/${ids.chat}/todo`],
    "/inbox": ["/inbox"],
    "/admin/wiki/pages": ["/admin/wiki/pages"],
    "/admin/wiki/pages/:pageId": [`/admin/wiki/pages/${MISSING}`],
    "/admin/wiki/pages/:pageId/history": [`/admin/wiki/pages/${MISSING}/history`],
    "/admin/wiki/pages/:pageId/diff": [`/admin/wiki/pages/${MISSING}/diff`],
    "/admin/wiki/pages/:pageId/versions/diff": [`/admin/wiki/pages/${MISSING}/versions/diff`],
    "/admin/wiki/pages/:pageId/links": [`/admin/wiki/pages/${MISSING}/links`],
    "/admin/wiki/rename-approvals": ["/admin/wiki/rename-approvals"],
    "/sessions/:sessionId/terminals": [`/sessions/${ids.chat}/terminals`],
    "/sessions/:sessionId/terminals/:terminalId/output": [
      `/sessions/${ids.chat}/terminals/${MISSING}/output`
    ],
    "/processes": ["/processes"],
    "/processes/output": [`/processes/output${q({ key: MISSING })}`],
    "/mobile/home": ["/mobile/home"],
    "/mobile/spaces": ["/mobile/spaces"],
    "/mobile/sessions/:sessionId/conversation": [ids.chat, ids.fork].map(
      (id) => `/mobile/sessions/${id}/conversation`
    ),
    "/relay": ["/relay"],
    "/cli-tools": ["/cli-tools"]
  }
}

interface Logged {
  readonly ms: number
  readonly sql: string
}

/** The same statement with a different number of `IN (?, ?)` values is one statement. */
const shape = (sql: string): string =>
  sql
    .replace(/\s+/g, " ")
    .replace(/\?(?:\s*,\s*\?)+/g, "?")
    .trim()

const readLog = (directory: string): ReadonlyArray<Logged> => {
  if (!existsSync(directory)) return []
  const rows: Array<Logged> = []
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".jsonl")) continue
    for (const line of readFileSync(join(directory, file), "utf8").split("\n")) {
      if (line.length > 0) rows.push(JSON.parse(line) as Logged)
    }
  }
  return rows
}

/** Each distinct statement with its fastest and slowest time and how often it ran. */
const fastest = (rows: ReadonlyArray<Logged>) => {
  const statements = new Map<string, { min: number; max: number; count: number; sql: string }>()
  for (const row of rows) {
    const key = shape(row.sql)
    const seen = statements.get(key)
    if (seen === undefined)
      statements.set(key, { min: row.ms, max: row.ms, count: 1, sql: row.sql })
    else {
      seen.min = Math.min(seen.min, row.ms)
      seen.max = Math.max(seen.max, row.ms)
      seen.count += 1
    }
  }
  return statements
}

const getRoutes = (): ReadonlyArray<string> => {
  const routes: Array<string> = []
  HttpApi.reflect(ArdenApi, {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      if (endpoint.method === "GET") routes.push(endpoint.path)
    }
  })
  return routes
}

const call = async (
  server: ServerHandle,
  url: string,
  timeoutMs = ROUTE_TIMEOUT_MS
): Promise<number | string> => {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await server.fetch(url, { signal: abort.signal })
    // An event stream never ends: its first frame is enough.
    await response.body?.getReader().read()
    return response.status
  } catch (cause) {
    return abort.signal.aborted ? "timed out" : String(cause)
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

/** Starts the server on the file, opens every screen, lets the timer jobs run, stops it. */
const sweep = async (
  databasePath: string,
  calls: ReadonlyArray<string>,
  log: string,
  waitMs: number,
  before?: (server: ServerHandle) => Promise<void>
): Promise<ReadonlyMap<string, number | string>> => {
  await mkdir(log, { recursive: true })
  const env = {
    ARDEN_TIMERS_AT_ONCE: "1",
    ARDEN_SQL_SLOW_LOG: log,
    ARDEN_SQL_SLOW_MS: "0"
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  let server: ServerHandle | undefined
  const answers = new Map<string, number | string>()
  try {
    server = await startServer({ port: 0, databasePath })
    await before?.(server)
    for (const url of calls) answers.set(url, await call(server, url))
    await sleep(waitMs)
  } finally {
    await server?.stop().catch(() => undefined)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return answers
}

interface Timing {
  readonly min: number
  readonly max: number
  readonly count: number
  /** One run's text as sent, for its plan. */
  readonly sql: string
}

/** The plan steps that say how much a statement reads: scans, sorts, automatic indexes. */
const planOf = (databasePath: string, sql: string): ReadonlyArray<string> => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database
      .prepare("ATTACH DATABASE ? AS search")
      .run(join(dirname(databasePath), "search.sqlite"))
    const steps = database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => String(row["detail"]))
    const telling = steps.filter((step) => /^SCAN|TEMP B-TREE|AUTOMATIC/.test(step))
    return [...new Set(telling.length > 0 ? telling : steps.slice(0, 3))]
  } catch (cause) {
    return [`(no plan: ${String(cause)})`]
  } finally {
    database.close()
  }
}

interface SizeResult {
  readonly scale: number
  readonly seedMs: number
  readonly measured: ReadonlyMap<string, Timing>
  readonly warmUp: ReadonlyMap<string, Timing>
  readonly failed: ReadonlyArray<string>
  readonly databasePath: string
}

/** Seeds a database at `scale`, warms it up, and runs the measured sweeps. */
const measure = async (directory: string, scale: number): Promise<SizeResult> => {
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, "arden.db")
  // A first start writes what a new install holds (built-in Automations,
  // settings); the history goes in after it.
  const first = await startServer({ port: 0, databasePath })
  await first.stop()
  const seedStarted = performance.now()
  const ids = seedFullSizeDatabase(databasePath, { scale })
  const seedMs = Math.round(performance.now() - seedStarted)

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const longAgo = new Date(Date.now() - 150 * scale * 86_400_000).toISOString()
  const table = routeCalls(ids, since, longAgo)
  const routes = getRoutes()
  const uncovered = routes.filter((route) => table[route] === undefined)
  expect(uncovered, "Add each new GET route to routeCalls, with real ids").toEqual([])
  const calls = routes.flatMap((route) => table[route] ?? [])

  // Warm-up: a first start on the seeded file does work an old database
  // did long ago. Its statements are reported, not judged.
  const warmLog = join(directory, "warm-up")
  await sweep(databasePath, calls, warmLog, TIMER_JOBS_MS, async (server) => {
    expect(await call(server, "/sessions/search?q=item", SEARCH_CATCH_UP_MS)).toBe(200)
  })

  const measuredLog = join(directory, "measured")
  const answers: Array<ReadonlyMap<string, number | string>> = []
  for (let start = 0; start < MEASURED_STARTS; start++)
    answers.push(await sweep(databasePath, calls, measuredLog, TIMER_JOBS_MS))

  // A route that answers with an error ran too little to judge its queries.
  const failed = calls.filter((url) => {
    const route = routes.find((path) => table[path]?.includes(url))
    if (route !== undefined && (NO_REAL_ID[route] !== undefined || OUTSIDE.has(route))) return false
    return answers.some((run) => {
      const status = run.get(url)
      return typeof status === "number" && status >= 500
    })
  })
  const result = {
    scale,
    seedMs,
    measured: fastest(readLog(measuredLog)),
    warmUp: fastest(readLog(warmLog)),
    failed,
    databasePath
  }
  return result
}

it(
  `no statement gets slower as the history grows (1x against ${LARGE_SCALE}x)`,
  { timeout: 1_200_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-growth-"))
    try {
      const small = await measure(join(directory, "small"), 1)
      await rm(join(directory, "small"), { recursive: true, force: true })
      const large = await measure(join(directory, "large"), LARGE_SCALE)

      expect(
        ALLOWED_TO_GROW.filter((entry) => entry.reason.trim().length === 0),
        "Every statement allowed to grow says why"
      ).toEqual([])
      const allowed = new Set(ALLOWED_TO_GROW.map((entry) => shape(entry.sql)))
      const compared = [...large.measured.entries()].map(([sql, big]) => ({
        sql,
        small: small.measured.get(sql),
        large: big
      }))
      const grown = compared
        .filter(
          ({ sql, small: before, large: after }) =>
            !allowed.has(sql) &&
            after.min >= GROWTH_FLOOR_MS &&
            after.min >= GROWTH_RATIO * (before?.min ?? 0)
        )
        .toSorted((a, b) => b.large.min - a.large.min)
        .map((entry) => ({ ...entry, plan: planOf(large.databasePath, entry.large.sql) }))
      // Slow on a server's first run of it (a cold page cache): listed, not judged.
      const firstRun = [...new Set([...small.measured.keys(), ...large.measured.keys()])]
        .map((sql) => ({ sql, small: small.measured.get(sql), large: large.measured.get(sql) }))
        .filter(
          (entry) => Math.max(entry.small?.max ?? 0, entry.large?.max ?? 0) >= FIRST_RUN_REPORT_MS
        )

      const report = process.env["ARDEN_SQL_SPEED_REPORT"]
      if (report !== undefined) {
        writeFileSync(
          report,
          JSON.stringify(
            {
              seedMs: { small: small.seedMs, large: large.seedMs },
              thresholds: { GROWTH_FLOOR_MS, GROWTH_RATIO, LARGE_SCALE },
              grown,
              firstRun,
              compared: compared.toSorted((a, b) => b.large.min - a.large.min),
              warmUp: {
                small: [...small.warmUp.entries()]
                  .filter(([, time]) => time.max >= FIRST_RUN_REPORT_MS)
                  .map(([sql, time]) => ({ ...time, sql })),
                large: [...large.warmUp.entries()]
                  .filter(([, time]) => time.max >= FIRST_RUN_REPORT_MS)
                  .map(([sql, time]) => ({ ...time, sql }))
              },
              noRealId: NO_REAL_ID
            },
            null,
            2
          )
        )
      }

      expect(
        { small: small.failed, large: large.failed },
        "Routes that failed on the seeded data"
      ).toEqual({ small: [], large: [] })
      expect(small.measured.size, "the slow log saw the sweep's statements").toBeGreaterThan(200)
      expect(
        grown.map(
          ({ sql, small: before, large: after, plan }) =>
            `${before?.min ?? "not run"} ms at 1x, ${after.min} ms at ${LARGE_SCALE}x: ${sql.slice(0, 200)}\n` +
            `      plan: ${plan.join(" | ")}`
        ),
        `Statements whose fastest time grows ${GROWTH_RATIO}x or more (and to ${GROWTH_FLOOR_MS} ms or more) ` +
          `when the history grows ${LARGE_SCALE}x. Start each from a short list, or list one-time ` +
          "work or an owner-approved exception in ALLOWED_TO_GROW with its reason."
      ).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
