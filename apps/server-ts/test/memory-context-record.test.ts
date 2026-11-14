import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RunMemoryContext, RunMemorySource } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { assembleMemoryContext } from "../src/context/memory-context.js"
import { makeContextExperiments } from "../src/context/experiments.js"
import type { RuntimeSection } from "../src/context/runtime-update.js"
import { renderSpaceContext, type SpaceView } from "../src/context/space-render.js"
import {
  composeTurnContext,
  type SessionOrigin,
  type TurnContextServices
} from "../src/context/turn-context.js"
import { prepareMemoryRecall, recallQuery } from "../src/memory/retrieval.js"
import type { Memory, MemoryTurn } from "../src/memory/service.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import type { SkillCatalog } from "../src/skills/service.js"
import type { TodoStore } from "../src/persistence/todos/store.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { SummaryStore } from "../src/persistence/summaries/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import type { Wiki } from "../src/wiki/service.js"
import type { CliTools } from "../src/cli-tools/service.js"
import type { FocusChoiceStore } from "../src/persistence/focus-choices/store.js"
import type { AnswerBlockStore } from "../src/persistence/answer-blocks/store.js"
import type { PermissionRules } from "../src/persistence/permissions/rules.js"
import type { ToolApprovalPolicy } from "../src/tools/approval-policy.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService, sessionHeader } from "./kit.js"

const QUERY = "orchard lantern ledger notes for the week"

const page = (path: string, title: string, body: string): PageRecord => {
  const pageId = `id-${path}`
  return {
    resource: {
      resourceId: pageId,
      path,
      blobId: `blob-${path}`,
      state: "active",
      versionId: `version-${path}`
    },
    page: Effect.runSync(
      parseWikiPage(
        formatWikiPage({
          pageId,
          title,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body
        }),
        pageId
      )
    )
  }
}

const core = page("me.md", "Me", "Prefers short replies.")
const orchard = page("notes/orchard.md", "Orchard lantern", "The orchard lantern ledger is kept.")
const ledger = page("notes/ledger.md", "Ledger notes", "Ledger notes for the orchard week.")

const recallOf = (pages: ReadonlyArray<PageRecord>, query: string) =>
  prepareMemoryRecall({ pages, query, lastChanged: new Map() }).render(new Map())

const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).byteLength

/**
 * Reads the prompt sections back without the assembler: every `### ` page block in the Memory
 * sections, by the page path it names, with its bytes as they stand in the prompt.
 */
const blocksInPrompt = (sections: ReadonlyArray<RuntimeSection>): ReadonlyMap<string, number> =>
  new Map(
    sections
      .filter((section) => section.key === "Core Memory" || section.key === "Memory context")
      .flatMap((section) => section.text.split(/\n\n(?=#{2,3} )/u))
      .filter((part) => part.startsWith("### "))
      .map((part) => [/\nPage: (.+)/u.exec(part)?.[1] ?? "", bytes(part)] as const)
  )

/** The record's sent page sources, by path, with their bytes. */
const recordedBlocks = (
  record: ReadonlyArray<RunMemorySource>,
  pages: ReadonlyArray<PageRecord>
): ReadonlyMap<string, number> =>
  new Map(
    record.flatMap((source) =>
      source.kind === "space" || source.outcome === "dropped"
        ? []
        : [
            [
              pages.find((record) => record.page.pageId === source.page_id)?.resource.path ?? "",
              source.bytes
            ] as const
          ]
    )
  )

interface Composed {
  readonly sections: ReadonlyArray<RuntimeSection>
  readonly writes: ReadonlyArray<RunMemoryContext>
  readonly searches: ReadonlyArray<string>
}

const compose = async (
  origin: SessionOrigin,
  pages: ReadonlyArray<PageRecord>,
  query: string = QUERY
): Promise<Composed> => {
  const writes: Array<RunMemoryContext> = []
  const searches: Array<string> = []
  const turn: MemoryTurn = {
    revision: "rev-1",
    readContent: () => Effect.die("no Space page in this test"),
    recall: (input) =>
      Effect.sync(() => {
        searches.push(input.query)
        return recallOf(pages, input.query)
      })
  }
  const header = sessionHeader({ sessionId: "session-1" })
  const services: TurnContextServices = {
    experiments: makeContextExperiments(),
    sessions: partialService<SessionQueries["Service"]>("SessionQueries", {
      loadHistoryHeader: () => Effect.succeed(header),
      listDirectAgentChildren: () => Effect.succeed([])
    }),
    runs: partialService<RunQueries["Service"]>("RunQueries", {
      authority: () => Effect.succeed(undefined),
      currentForSessions: () => Effect.succeed(new Map())
    }),
    skills: partialService<SkillCatalog["Service"]>("SkillCatalog", {
      promptCatalog: () => Effect.succeed(undefined)
    }),
    memory: partialService<Memory["Service"]>("Memory", {
      withTurn: (consume) => consume(turn)
    }),
    todos: partialService<TodoStore["Service"]>("TodoStore", {
      getOverride: () => Effect.succeed(null)
    }),
    spaces: partialService<SpaceStore["Service"]>("SpaceStore", {}),
    summaries: partialService<SummaryStore["Service"]>("SummaryStore", {}),
    work: partialService<WorkStore["Service"]>("WorkStore", {
      continuationContext: () => Effect.succeed(undefined),
      chatTask: () => Effect.succeed(undefined)
    }),
    wiki: partialService<Wiki["Service"]>("Wiki", {}),
    cliTools: partialService<CliTools["Service"]>("CliTools", {
      known: () => Effect.succeed(undefined)
    }),
    focusChoices: partialService<FocusChoiceStore["Service"]>("FocusChoiceStore", {
      threads: () => Effect.succeed([])
    }),
    answerBlocks: partialService<AnswerBlockStore["Service"]>("AnswerBlockStore", {}),
    chat: {
      recordMemoryContext: (input) => Effect.sync(() => void writes.push(input.context))
    },
    permissions: partialService<ToolApprovalPolicy>("ToolApprovalPolicy", {}),
    rules: partialService<PermissionRules["Service"]>("PermissionRules", {}),
    dataDir: "/nonexistent-data-dir"
  }
  const context = await Effect.runPromise(
    composeTurnContext(services, origin, {
      sessionId: "session-1",
      runId: "run-1",
      messages: [{ role: "user", content: query }],
      signal: new AbortController().signal
    })
  )
  return { sections: context.sections, writes, searches }
}

const personal: SessionOrigin = {
  source: "personal",
  header: null,
  starting: undefined,
  special: undefined
}
const automation = (purpose: "user_automation" | "task_execution"): SessionOrigin => ({
  source: "scheduled_task",
  automationId: AutomationId.make("automation-1"),
  policy: { purpose, handler: null, toolScope: "all", autoApprove: false, threadId: null },
  header: sessionHeader({ sessionId: "session-1" }),
  fork: false,
  ownRun: true
})
const helper: SessionOrigin = {
  source: "agent",
  mode: "research",
  header: sessionHeader({ sessionId: "session-1", sessionType: "agent" })
}

const memoryKeys = (sections: ReadonlyArray<RuntimeSection>) =>
  sections
    .map((section) => section.key)
    .filter((key) => ["Core Memory", "Current Space", "Memory context"].includes(key))

describe("what a run was sent from Memory", () => {
  it("an owner chat records each source it was sent, and the record matches the prompt", async () => {
    const pages = [core, orchard, ledger]
    const composed = await compose(personal, pages)
    const record = composed.writes.at(-1)?.sources ?? []
    expect(memoryKeys(composed.sections)).toEqual(["Core Memory", "Memory context"])
    expect({ ...composed.writes.at(-1), sources: undefined }).toEqual({
      revision: "rev-1",
      query: QUERY,
      sources: undefined
    })
    expect(record.map(({ bytes: _bytes, ...rest }) => rest)).toEqual([
      {
        kind: "core",
        page_id: "id-me.md",
        version: "version-me.md",
        outcome: "whole",
        reason: null
      },
      ...[ledger, orchard].map((record) => ({
        kind: "recalled",
        page_id: record.page.pageId,
        version: record.resource.versionId,
        outcome: "whole",
        reason: null
      }))
    ])
    expect(recordedBlocks(record, pages)).toEqual(blocksInPrompt(composed.sections))
    expect(composed.writes).toHaveLength(1)
  })

  it.each([
    ["an Automation run", automation("user_automation")],
    ["a task worker", automation("task_execution")],
    ["a helper", helper]
  ])("%s is sent no Memory, so it records none", async (_kind, origin) => {
    const composed = await compose(origin, [core, orchard, ledger])
    expect({
      sections: memoryKeys(composed.sections),
      searches: composed.searches,
      writes: composed.writes
    }).toEqual({
      sections: [],
      searches: [],
      writes: [{ revision: null, query: null, sources: [] }]
    })
  })

  it("a long owner message is kept once, as far as the word search read it", async () => {
    const long = `${QUERY} ${"pasted document text ".repeat(2_000)}`
    const composed = await compose(personal, [core, orchard, ledger], long)
    const record = composed.writes.at(-1)
    expect(composed.searches).toEqual([long])
    expect(record?.query).toBe(recallQuery(long))
    expect(record?.query).toHaveLength(512)
    expect(record?.sources.filter((source) => source.kind === "recalled")).toHaveLength(2)
    expect(JSON.stringify(record).length).toBeLessThan(2_000)
  })

  it("names the allowance that cut or dropped a page, and still matches the prompt", async () => {
    const bigCore = page("me.md", "Me", `${"Prefers short replies. ".repeat(600)}`)
    const long = page("notes/orchard.md", "Orchard lantern", `${"orchard ledger ".repeat(900)}`)
    const crowded = page("notes/ledger.md", `Ledger notes ${"x".repeat(4_000)}`, "Ledger week.")
    const pages = [bigCore, long, crowded]
    const composed = await compose(personal, pages)
    const record = composed.writes.at(-1)?.sources ?? []
    expect(
      record.map((source) => ({
        page: source.page_id,
        outcome: source.outcome,
        reason: source.reason
      }))
    ).toEqual([
      { page: "id-me.md", outcome: "cut", reason: "core_page_budget" },
      { page: "id-notes/ledger.md", outcome: "dropped", reason: "recall_allowance" },
      { page: "id-notes/orchard.md", outcome: "cut", reason: "recall_allowance" }
    ])
    expect(record.find((source) => source.outcome === "dropped")?.bytes).toBe(0)
    expect(recordedBlocks(record, pages)).toEqual(blocksInPrompt(composed.sections))
  })
})

const spaceView = (content: string | undefined): SpaceView => ({
  space_id: "space-1",
  name: "Garden",
  instructions: undefined,
  isConversation: true,
  conversation: undefined,
  chats: [],
  page: content === undefined ? undefined : { path: "spaces/garden.md", content },
  questions: [],
  tasks: []
})

describe("the continuity budget and the Space", () => {
  const recall = recallOf([orchard, ledger], QUERY)
  const assemble = (
    text: string,
    content: string | undefined,
    recalled: "recalled" | "no recall" = "recalled"
  ) => {
    const view = spaceView(content)
    const rendered = renderSpaceContext(view)
    return assembleMemoryContext({
      space: {
        view,
        text,
        page:
          rendered.page === undefined
            ? undefined
            : { pageId: "space-page", version: "space-page-v1", shown: rendered.page }
      },
      recall: recalled === "recalled" ? recall : undefined,
      revision: "rev-1",
      query: QUERY
    })
  }

  it("records the Space whole, and the recall it leaves room for cut or dropped", () => {
    const recallBytes = bytes(recall.text ?? "")
    const roomy = assemble("Space context.", undefined)
    // Room for the intro and the first page block only, part of the second.
    const tight = assemble("s".repeat(16_000 - 2 - recallBytes + 20), undefined)
    const full = assemble("s".repeat(16_000), undefined)
    const outcomes = (context: ReturnType<typeof assemble>) =>
      context.record.sources.map((source) => [source.kind, source.outcome, source.reason])
    expect(outcomes(roomy)).toEqual([
      ["space", "whole", null],
      ["recalled", "whole", null],
      ["recalled", "whole", null]
    ])
    expect(outcomes(tight)).toEqual([
      ["space", "whole", null],
      ["recalled", "whole", null],
      ["recalled", "cut", "continuity_budget"]
    ])
    expect(outcomes(full)).toEqual([
      ["space", "whole", null],
      ["recalled", "dropped", "continuity_budget"],
      ["recalled", "dropped", "continuity_budget"]
    ])
    expect(full.recall).toEqual([])
    for (const context of [roomy, tight, full]) {
      expect(context.record.sources[0]?.bytes).toBe(bytes(context.space[0]?.text ?? ""))
      expect(recordedBlocks(context.record.sources, [orchard, ledger])).toEqual(
        blocksInPrompt(context.recall)
      )
    }
  })

  it("names the Space page, and says when the Space's allowance cut it", () => {
    const whole = assemble("Space context.", "A short page.")
    const cut = assemble("Space context.", "line\n".repeat(20_000))
    expect([whole.record.sources[0], cut.record.sources[0]]).toEqual([
      {
        kind: "space",
        space_id: "space-1",
        page_id: "space-page",
        version: "space-page-v1",
        bytes: bytes("Space context."),
        outcome: "whole",
        reason: null
      },
      {
        kind: "space",
        space_id: "space-1",
        page_id: "space-page",
        version: "space-page-v1",
        bytes: bytes("Space context."),
        outcome: "cut",
        reason: "space_page_allowance"
      }
    ])
  })

  it("names the Memory revision the Space page was read at when no recall ran", () => {
    const alone = assemble("Space context.", "A short page.", "no recall")
    expect({ ...alone.record, sources: alone.record.sources.map((source) => source.kind) }).toEqual(
      { revision: "rev-1", query: null, sources: ["space"] }
    )
  })
})

describe("one assembler", () => {
  // Memory reaches the prompt only through `assembleMemoryContext`, which returns the
  // sections and their record together. A second place that budgets Memory or builds its
  // sections would send Memory without a record.
  it("no other source file budgets Memory context or builds its sections", () => {
    const root = join(import.meta.dirname, "../src")
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts")
    )
    const offenders = files.toSorted().flatMap((relative) => {
      const text = readFileSync(join(root, relative), "utf8")
      return [
        /budgetContinuityContext\(/u.test(text) && !relative.endsWith("continuity-budget.ts")
          ? `${relative}: budgetContinuityContext`
          : undefined,
        /"(Core Memory|Memory recall|Current Space)"/u.test(text) &&
        /textSection\(|kind: "space"/u.test(text) &&
        !relative.endsWith("runtime-update.ts")
          ? `${relative}: Memory section`
          : undefined
      ].filter((offender) => offender !== undefined)
    })
    expect(offenders).toEqual([
      "context/memory-context.ts: budgetContinuityContext",
      "context/memory-context.ts: Memory section"
    ])
  })
})

describe("the stored record", () => {
  const source = (pageId: string): RunMemorySource => ({
    kind: "recalled",
    page_id: pageId,
    version: "version-1",
    bytes: 120,
    outcome: "cut",
    reason: "continuity_budget"
  })
  const first: RunMemoryContext = {
    revision: "rev-1",
    query: "a made-up question",
    sources: [source("page-a"), source("page-b")]
  }
  const steered: RunMemoryContext = {
    revision: "rev-1",
    query: "a made-up steer",
    sources: [source("page-c")]
  }
  const none: RunMemoryContext = { revision: null, query: null, sources: [] }

  it("keeps every composition of a run in order, once each, and adds no row for none", async () => {
    const result = await withTempDatabase(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        const runs = yield* RunQueries
        for (const context of [first, first, steered, steered, none, none])
          yield* chat.recordMemoryContext({ runId: "run-a", sessionId: "s-a", context })
        yield* chat.recordMemoryContext({ runId: "run-b", sessionId: "s-b", context: none })
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM run_sidecars`
        return {
          kept: yield* runs.memoryContext("run-a"),
          never: yield* runs.memoryContext("run-b"),
          rows: rows.map((row) => row.run_id)
        }
      })
    )
    expect(result).toEqual({ kept: [first, steered, none], never: [], rows: ["run-a"] })
  })
})
