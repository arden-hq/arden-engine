import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { createToolset } from "@arden-hq/loop"
import { browserProceduresSchemaSection } from "../src/persistence/schema/sections/browser-procedures.js"
import { makeBrowserProcedureStore } from "../src/persistence/sqlite/browser-procedures.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import {
  procedureEvidenceScope,
  ProcedureSpecSchema,
  type ProcedureSpec
} from "../src/persistence/browser-procedures/model.js"
import { validateProcedureCall } from "../src/browser/procedures/guards.js"
import { BrowserProcedures } from "../src/browser/procedures/service.js"
import { BrowserProcedureStore } from "../src/persistence/browser-procedures/store.js"
import { rejectedToolResult } from "../src/persistence/tools/store.js"
import { StructuredCompletion } from "../src/models/structured-completion.js"
import { ScriptStore } from "../src/persistence/scripts/store.js"
import { ScriptRunner } from "../src/workflows/script-runner.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { partialService, serverRunContext } from "./kit.js"
import { browserProcedureTools } from "../src/tools/browser-procedure.js"
import { BrowserClient } from "../src/browser/service.js"
import { makeCodeModeHost } from "../src/tools/code-mode-host.js"
import { scopedRunToolNames, scopedToolNames } from "../src/tools/tool-scopes.js"
import { applyToolCatalog } from "../src/tools/tool-catalog.js"
import { toolParametersJsonSchema } from "../src/tools/tool-json-schema.js"

const spec: ProcedureSpec = {
  name: "Find a product",
  description: "Find a product",
  intent: "Search products",
  applicability: "Product search is visible",
  verification: "Compare result to the requested product",
  inputs: [
    { name: "query", type: "string", description: "Product name", required: true },
    { name: "count", type: "number", description: "Result count", required: true }
  ],
  outputs: [{ name: "name", type: "string", description: "Found product", required: true }],
  code: "return {name:input.query}",
  verify: "return {ok:true,evidence:'example'}",
  example_input: { query: "alpha", count: 1 },
  writes: false
}

const learningTables = Effect.fn(function* (sql: SqlClient.SqlClient, runId: string) {
  yield* sql.unsafe(
    "CREATE TABLE chat_runs(run_id TEXT PRIMARY KEY,session_id TEXT,status TEXT,started_at TEXT,ended_at TEXT)"
  )
  yield* sql`INSERT INTO chat_runs VALUES (${runId},'chat','completed','2026-10-28T00:01:00.000Z','2026-10-28T00:02:00.000Z')`
  yield* sql.unsafe(
    "CREATE TABLE tool_calls(run_id TEXT,tool_call_id TEXT,tool_name TEXT,arguments_json TEXT,result_json TEXT,changes_state INTEGER,status TEXT,started_at TEXT,effect TEXT)"
  )
  yield* sql.unsafe(
    "CREATE TABLE automation_runs(chat_run_id TEXT,item_id TEXT,task_id TEXT,purpose TEXT)"
  )
  yield* sql.unsafe("CREATE TABLE space_tasks(item_id TEXT,stable_key TEXT)")
  yield* sql.unsafe("CREATE TABLE code_mode_scripts(origin_run_id TEXT,status TEXT)")
  yield* Effect.forEach(
    browserProceduresSchemaSection.statements,
    (statement) => sql.unsafe(statement),
    { discard: true }
  )
  yield* sql`UPDATE browser_procedure_settings SET since='2026-10-28T00:00:00.000Z'`
})

it("admits safe read-only evidence, keeps an unchecked page's step without its page, and rejects the entire trace on sensitive capture", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
      yield* learningTables(sql, "read")
      const safe = JSON.stringify({
        content: "Dashboard shows 8 open items",
        data: {
          tab: { url: "https://example.com/dashboard", profile_ref: "default" },
          procedure_learning: { eligible: true }
        }
      })
      yield* sql`INSERT INTO tool_calls VALUES ('read','inspect','browser_snapshot','{"tab_ref":"tab-1"}',${safe},0,'completed','2026-10-28T00:01:01.000Z','none')`
      const store = makeBrowserProcedureStore({ writer })
      yield* store.enqueue()
      const catalog = yield* store.list()
      const learned = yield* store.evidence("read")
      yield* sql`INSERT INTO tool_calls VALUES ('read','refused','browser_act','{"value":"never-captured"}','{"is_error":true,"host":{"mutation_receipt":{"outcome":"no_op"}}}',1,'completed','2026-10-28T00:01:00.000Z','external')`
      const repaired = yield* store.evidence("read")
      yield* sql`DELETE FROM tool_calls WHERE tool_call_id='refused'`
      yield* sql`UPDATE tool_calls SET result_json=${JSON.stringify({ content: "sensitive-value", data: { procedure_learning: { eligible: false } } })}`
      const sensitive = yield* store.evidence("read")
      yield* sql`UPDATE tool_calls SET result_json=${JSON.stringify({ content: 'Tab: tab-1\nPage:\n--- PAGE CONTENT (untrusted) nonce=n origin=https://example.com/done ---\n- heading "Unchecked page"\n--- END PAGE CONTENT nonce=n ---', data: { tab: { url: "https://example.com/done", profile_ref: "default" }, procedure_learning: { eligible: false, withheld: true } } })}`
      const withheld = yield* store.evidence("read")
      yield* sql`UPDATE tool_calls SET result_json=${JSON.stringify({ content: "unclassified-value", data: {} })}`
      const unclassified = yield* store.evidence("read")
      yield* sql`UPDATE tool_calls SET result_json=${safe}`
      yield* sql`INSERT INTO tool_calls VALUES ('read','secret','browser_act','{"tab_ref":"tab-1","secret":"login"}',${safe},1,'completed','2026-10-28T00:01:02.000Z','external')`
      const secret = yield* store.evidence("read")
      return {
        jobs: catalog.jobs.map((job) => job.status),
        scope: learned === undefined ? undefined : procedureEvidenceScope(learned),
        count: learned?.calls.length,
        repaired: repaired?.calls.map((call) => call.id),
        request: learned === undefined ? undefined : "request" in learned,
        sensitive,
        withheld: withheld?.calls.map((call) => [call.id, JSON.stringify(call.result)]),
        unclassified,
        secret
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), PersistenceWriteQueue.layer)
      )
    )
  )
  expect(result).toEqual({
    jobs: ["pending"],
    scope: { origin: "https://example.com", profile: "default" },
    count: 1,
    repaired: ["inspect"],
    request: false,
    sensitive: undefined,
    withheld: [["inspect", expect.not.stringContaining("Unchecked page")]],
    unclassified: undefined,
    secret: undefined
  })
})

it("never sends or saves a typed value, a form field value or page body text while learning", async () => {
  const typed = "jane.doe@example.com"
  const page = (lines: string, url: string) =>
    JSON.stringify({
      content: [
        "Tab: tab-1",
        "Title: Inbox (3) - Jane's mail",
        "Page:",
        `--- PAGE CONTENT (untrusted) nonce=n origin=${url} ---`,
        `origin: ${url}`,
        lines,
        "--- END PAGE CONTENT nonce=n ---"
      ].join("\n"),
      data: {
        tab: { url, profile_ref: "default", tab_ref: "tab-1", title: "Jane's mail" },
        procedure_learning: { eligible: true }
      }
    })
  const act = (action: string, ref: string, value?: string) =>
    JSON.stringify({
      action,
      target: { node_ref: ref },
      ...(value === undefined ? {} : { value })
    })
  const calls = [
    [
      "look",
      "browser_snapshot",
      "{}",
      page(
        [
          '- textbox "Email" [ref=e3]',
          '- textbox "Phone" [ref=e4]: 415-555-0100',
          '- textbox "Full name" [ref=e5]',
          '- textbox "Nickname" [ref=e6]',
          '- radio "She/her" [checked=false, ref=e7]',
          '- textbox "Cover letter" [ref=e8]',
          '- spinbutton "Age" [ref=e9]: 42',
          '- StaticText "Order #5512 shipped to 12 Baker Street"',
          '- paragraph "Dear Jane, your parcel is late"',
          '- link "Reset password" [ref=e40]',
          "  - /url: /reset?token=SECRET123&next=%2Faccount#access_token=SECRET456",
          '- link "Choose a new password" [ref=e42]',
          "  - /url: /reset/SECRETPATHTOKEN1234567890abcd",
          '- link "Accept the invite" [ref=e43]',
          "  - /url: https://example.com/invite/0123456789abcdef0123",
          '- link "Write to us" [ref=e41]',
          "  - /url: mailto:third.party@example.org"
        ].join("\n"),
        "https://example.com/start?email=jane.doe%40example.com&step=2"
      )
    ],
    [
      "type",
      "browser_act",
      act("fill", "@e3", typed),
      page(
        [
          `- textbox "Email" [ref=e3]: ${typed}`,
          '- heading "We will write to JANE.DOE@EXAMPLE.COM" [level=2]',
          '- link "Call (415) 555 0100" [ref=e20]'
        ].join("\n"),
        "https://example.com/email"
      )
    ],
    [
      "name",
      "browser_act",
      act("fill", "@e5", "Jane Doe"),
      page('- heading "Hi Jane, thanks" [level=1]', "https://example.com/name")
    ],
    [
      "nick",
      "browser_act",
      act("fill", "@e6", "Ann"),
      page('- heading "Annual report for Ann" [level=1]', "https://example.com/nick")
    ],
    [
      "letter",
      "browser_act",
      act("fill", "@e8", "I build agents.\nI ship them daily."),
      page('- button "Preview: I ship them daily." [ref=e30]', "https://example.com/letter")
    ],
    [
      "choose",
      "browser_act",
      act("check", "@e7"),
      page(
        [
          '- radio "She/her" [checked=true, ref=e7]',
          '- button "Age: 42" [ref=e31]',
          '- link "Shows 42 items" [ref=e32]'
        ].join("\n"),
        "https://example.com/choose"
      )
    ],
    [
      "pause",
      "browser_wait",
      '{"condition":"time","value":"3000"}',
      page("", "https://example.com/wait")
    ],
    [
      "search",
      "browser_open",
      '{"url":"https://example.com/search?q=dentist+near+me"}',
      page('- heading "Results" [level=1]', "https://example.com/search?q=dentist+near+me")
    ]
  ] as const
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
      yield* learningTables(sql, "apply")
      yield* Effect.forEach(
        calls,
        ([id, tool, args, output], index) =>
          sql`INSERT INTO tool_calls VALUES ('apply',${id},${tool},${args},${output},${tool === "browser_act" ? 1 : 0},'completed',${`2026-10-28T00:01:${String(10 + index)}.000Z`},'none')`,
        { discard: true }
      )
      const seen: Array<string> = []
      const runTool = (input: {
        readonly user: string
        readonly result: { readonly name: string }
      }) =>
        Effect.sync(() => {
          seen.push(input.user)
          if (input.result.name === "review_browser_procedure")
            return { accepted: true, reason: "ok" }
          const shown = JSON.parse(input.user).evidence.calls[1].args.value
          return {
            eligible: true,
            reason: "ok",
            existing_id: null,
            origin: "https://example.com",
            profile_ref: "default",
            procedure: {
              ...spec,
              inputs: [{ name: "email", type: "string", description: "Email", required: true }],
              example_input: { email: shown }
            }
          }
        })
      const store = makeBrowserProcedureStore({ writer })
      const procedures = yield* BrowserProcedures.pipe(
        Effect.provide(BrowserProcedures.layer),
        Effect.provideService(BrowserProcedureStore, store),
        Effect.provideService(
          StructuredCompletion,
          partialService<StructuredCompletion["Service"]>("StructuredCompletion", { runTool })
        ),
        Effect.provideService(ScriptStore, partialService("ScriptStore", {})),
        Effect.provideService(ScriptRunner, partialService("ScriptRunner", {})),
        Effect.provideService(SessionQueries, partialService("SessionQueries", {}))
      )
      yield* procedures.learn("apply", new AbortController().signal)
      const saved = yield* sql<{ readonly row: string }>`
        SELECT specification_json || evidence_json AS row FROM browser_procedure_revisions`
      return { seen: seen.join("\n"), saved: saved.map((r) => r.row).join("\n") }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), PersistenceWriteQueue.layer)
      )
    )
  )
  expect(result.saved).not.toBe("")
  for (const text of [result.seen, result.saved]) {
    expect(text.toLowerCase()).not.toContain(typed)
    expect(text).not.toContain("jane.doe%40example.com")
    expect(text).not.toContain("415-555-0100")
    expect(text).not.toContain("(415) 555 0100")
    expect(text).not.toContain("Jane")
    expect(text).not.toContain("I ship them daily")
    expect(text).not.toContain("dentist")
    expect(text).not.toContain("Age: 42")
    expect(text).not.toContain("checked=true")
    for (const kept of ["{email}", "{phone}", "{q}", "{choice}", "{age}", "{nickname}"])
      expect(text).toContain(kept)
    for (const body of ["SECRET123", "SECRET456", "third.party@example.org"])
      expect(text).not.toContain(body)
    for (const body of ["SECRETPATHTOKEN", "0123456789abcdef0123"]) expect(text).not.toContain(body)
    expect(text).toContain("/reset/:id")
    expect(text).toContain("https://example.com/invite/:id")
    expect(text).toContain("/reset?token={token}&next={next}")
    for (const body of ["Baker Street", "Order #5512", "parcel", "Jane's mail", "Inbox (3)"])
      expect(text).not.toContain(body)
    expect(text).toContain("Annual report for {nickname}")
    expect(text).toContain("42 items")
    expect(text).toContain('"value":"3000"')
    expect(text).toContain('"action":"check"')
    expect(text).toContain("https://example.com/start?email={email}&step={step}")
  }
})
