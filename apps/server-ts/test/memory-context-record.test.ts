import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { RunMemoryContextSchema } from "@arden-hq/protocol/effect/runs"
import type { RunMemoryContext, RunMemorySource } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import type { ChatRunnerMessage } from "../src/chat/runner-contract.js"
import { makeContextExperiments } from "../src/context/experiments.js"
import { MEMORY_BLOCK_MAX_BYTES, MEMORY_BUDGET } from "../src/context/memory-context.js"
import type { RuntimeSection } from "../src/context/runtime-update.js"
import {
  composeTurnContext,
  type SessionOrigin,
  type TurnContextServices
} from "../src/context/turn-context.js"
import { unrecordedAuthority, type Actor, type RunAuthority } from "../src/execution/authority.js"
import { renderIndex } from "../src/memory/index-render.js"
import { prepareMemorySources, recallCandidates, recallQuery } from "../src/memory/retrieval.js"
import type { Memory, MemoryTurn } from "../src/memory/service.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import type { SkillCatalog } from "../src/skills/service.js"
import type { TodoStore } from "../src/persistence/todos/store.js"
import type { PersistedSpace, SpaceStore } from "../src/persistence/spaces/store.js"
import type { SummaryStore } from "../src/persistence/summaries/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import type { Wiki } from "../src/wiki/service.js"
import type { CliTools } from "../src/cli-tools/service.js"
import type { FocusChoiceStore } from "../src/persistence/focus-choices/store.js"
import type { AnswerBlockStore } from "../src/persistence/answer-blocks/store.js"
import type { PermissionRules } from "../src/persistence/permissions/rules.js"
import type { ToolApprovalPolicy } from "../src/tools/approval-policy.js"
import type { AutomationId } from "../src/persistence/automations/model.js"
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
const spacePage = page("spaces/garden.md", "Garden", "The garden orchard ledger plan.")
const PAGES = [core, orchard, ledger, spacePage]

const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).byteLength

const MEMORY_KEYS = ["Core Memory", "Memory index", "Current Space", "Memory context"]
const memoryKeys = (sections: ReadonlyArray<RuntimeSection>) =>
  sections.map((section) => section.key).filter((key) => MEMORY_KEYS.includes(key))

const blocksInPrompt = (sections: ReadonlyArray<RuntimeSection>): ReadonlyMap<string, number> =>
  new Map(
    sections
      .filter((section) => section.key === "Core Memory" || section.key === "Memory context")
      .flatMap((section) => section.text.split(/\n\n(?=#{2,3} |\[Also matched)/u))
      .filter((part) => part.startsWith("### "))
      .map((part) => [/\nPage: (.+)/u.exec(part)?.[1] ?? "", bytes(part.trimEnd())] as const)
  )

/** The record's sent page sources, by path, with their bytes. */
const recordedBlocks = (
  record: ReadonlyArray<RunMemorySource>,
  pages: ReadonlyArray<PageRecord>
): ReadonlyMap<string, number> =>
  new Map(
    record.flatMap((source) =>
      (source.kind !== "core" && source.kind !== "recalled") || source.outcome === "dropped"
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

const gardenSpace = (spaceId: string, instructions: string | null): PersistedSpace => ({
  inference: { enabled: false },
  space_id: spaceId,
  name: "Garden",
  instructions,
  instructions_source: null,
  page_path: spacePage.resource.path,
  mark: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  archived_at: null,
  page_id: spacePage.page.pageId
})

const authorityOf = (actor: Actor | undefined): RunAuthority | undefined =>
  actor === undefined ? undefined : { ...unrecordedAuthority("session-1"), actor }

type OriginSource = SessionOrigin["source"]

const compose = async ({
  actor,
  pages = PAGES,
  messages = [{ role: "user", content: QUERY }],
  spaceId = null,
  instructions = null,
  spaceBody = spacePage.page.body,
  originSource = "personal"
}: {
  readonly actor: Actor | undefined
  readonly pages?: ReadonlyArray<PageRecord>
  readonly messages?: ReadonlyArray<ChatRunnerMessage>
  readonly spaceId?: string | null
  readonly instructions?: string | null
  readonly spaceBody?: string
  readonly originSource?: OriginSource
}): Promise<Composed> => {
  const writes: Array<RunMemoryContext> = []
  const searches: Array<string> = []
  const turn: MemoryTurn = {
    revision: "rev-1",
    readContent: (pageId) =>
      Effect.succeed({
        pageId,
        path: spacePage.resource.path,
        version: spacePage.resource.versionId,
        content: spaceBody
      }),
    spaceList: (space) => (maxBytes) => renderIndex(pages, { kind: "space", space }, maxBytes),
    sources: (input) =>
      Effect.sync(() => {
        if (input.recall !== undefined) searches.push(input.recall.query)
        return prepareMemorySources({
          pages,
          recall:
            input.recall === undefined
              ? undefined
              : recallCandidates({
                  pages,
                  query: input.recall.query,
                  today: "2026-11-14",
                  sentElsewhere: new Set(input.recall.excludePageIds ?? [])
                }),
          lastChanged: new Map()
        }).render(new Map())
      })
  }
  const header = sessionHeader({ sessionId: "session-1", spaceId })
  const services: TurnContextServices = {
    experiments: makeContextExperiments(),
    sessions: partialService<SessionQueries["Service"]>("SessionQueries", {
      loadHistoryHeader: () => Effect.succeed(header),
      listDirectAgentChildren: () => Effect.succeed([])
    }),
    runs: partialService<RunQueries["Service"]>("RunQueries", {
      authority: () => Effect.succeed(authorityOf(actor)),
      currentForSessions: () => Effect.succeed(new Map()),
      get: () => Effect.die("no run rows in this test"),
      cause: () => Effect.die("no run rows in this test")
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
    spaces: partialService<SpaceStore["Service"]>("SpaceStore", {
      get: (id) => Effect.succeed(gardenSpace(id, instructions)),
      detail: () => Effect.succeed(null)
    }),
    summaries: partialService<SummaryStore["Service"]>("SummaryStore", {
      spaceChats: () => Effect.succeed([])
    }),
    work: partialService<WorkStore["Service"]>("WorkStore", {
      continuationContext: () => Effect.succeed(undefined),
      chatTask: () => Effect.succeed(undefined),
      questions: () => Effect.succeed({ questions: [], next_cursor: null })
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
    permissions: partialService<ToolApprovalPolicy>("ToolApprovalPolicy", {
      live: () => Effect.fail("no permission rules in this test" as never)
    }),
    rules: partialService<PermissionRules["Service"]>("PermissionRules", {
      inLists: () => Effect.die("no permission rules in this test")
    }),
    dataDir: "/nonexistent-data-dir"
  }
  const origins: Record<OriginSource, SessionOrigin> = {
    personal: { source: "personal", header, starting: undefined, special: undefined },
    agent: { source: "agent", mode: "research", header },
    scheduled_task: {
      source: "scheduled_task",
      automationId: "automation-1" as AutomationId,
      policy: {
        purpose: "user_automation",
        handler: null,
        toolScope: "all",
        autoApprove: false,
        threadId: "session-1"
      },
      header,
      fork: false,
      ownRun: true
    }
  }
  const origin = origins[originSource]
  const context = await Effect.runPromise(
    composeTurnContext(services, origin, {
      sessionId: "session-1",
      runId: "run-1",
      messages,
      signal: new AbortController().signal
    })
  )
  return { sections: context.sections, writes, searches }
}

const person: Actor = { kind: "person", session_id: "session-1", turn_id: "turn-1" }
const ACTORS: ReadonlyArray<readonly [string, Actor | undefined, "owner" | "worker" | "none"]> = [
  ["a person", person, "owner"],
  [
    "a helper of a person's chat",
    { kind: "agent", mode: "research", parent_run_id: "run-0", root: "person" },
    "worker"
  ],
  ["a Task worker", { kind: "task_worker", item_id: "task-1", space_id: "space-1" }, "worker"],
  ["a Space review", { kind: "space_review", space_id: "space-1" }, "worker"],
  ["a run with no recorded actor", undefined, "worker"],
  [
    "an owner Automation",
    { kind: "automation", automation_id: "a-1", purpose: "user_automation", handler: null },
    "none"
  ],
  [
    "a system Automation",
    { kind: "automation", automation_id: "a-2", purpose: "system", handler: "memory_capture" },
    "none"
  ],
  [
    "a helper of an Automation",
    { kind: "agent", mode: "research", parent_run_id: "run-0", root: "automation" },
    "none"
  ]
]

const ORIGINS: ReadonlyArray<OriginSource> = ["personal", "agent", "scheduled_task"]

describe("which runs are sent Memory, by recorded actor, whatever the chat's origin", () => {
  it.each(
    ACTORS.flatMap(([name, actor, reader]) =>
      ORIGINS.flatMap(
        (originSource) =>
          [
            [`${name}, ${originSource} chat`, actor, reader, null, originSource],
            [`${name}, ${originSource} chat in a Space`, actor, reader, "space-1", originSource]
          ] as const
      )
    )
  )("%s", async (_name, actor, reader, spaceId, originSource) => {
    const composed = await compose({ actor, spaceId, originSource })
    const expected = {
      owner: [
        "Core Memory",
        "Memory index",
        ...(spaceId === null ? [] : ["Current Space"]),
        "Memory context"
      ],
      worker: ["Core Memory", "Memory index"],
      none: []
    }[reader]
    expect(memoryKeys(composed.sections)).toEqual(expected)
    expect(composed.searches).toEqual(reader === "owner" ? [QUERY] : [])
    if (reader === "none") expect(composed.writes).toEqual([])
    else expect(composed.writes.map((write) => write.reader)).toEqual([reader])
  })

  it("never recalls a standing-facts page, which is sent whole already", async () => {
    const matching = page("profile.md", "Profile", QUERY)
    const composed = await compose({ actor: person, pages: [matching, orchard, ledger] })
    expect(
      composed.writes[0]?.sources.filter((source) => source.page_id === "id-profile.md")
    ).toEqual([expect.objectContaining({ kind: "core" })])
  })

  it("records a Space page its share cut as cut", async () => {
    const composed = await compose({
      actor: person,
      spaceId: "space-1",
      spaceBody: "The garden orchard ledger plan, line by line.\n".repeat(200)
    })
    expect(composed.writes[0]?.sources.find((source) => source.kind === "space")).toMatchObject({
      outcome: "cut",
      reason: "space_page_allowance"
    })
  })

  it("lists the Space's other pages in the Space block, recorded as the index of its folder", async () => {
    const beds = page("spaces/garden/beds.md", "Beds", "Raised beds.")
    const seeds = page("spaces/garden/seeds/list.md", "Seeds", "Seed list.")
    const composed = await compose({
      actor: person,
      spaceId: "space-1",
      pages: [...PAGES, beds, seeds]
    })
    const text = composed.sections.find((section) => section.key === "Current Space")?.text
    expect(text).toContain("- spaces/garden/beds.md")
    expect(text).toContain("- spaces/garden/seeds/list.md")
    const record = composed.writes[0]?.sources ?? []
    expect(record.find((source) => source.kind === "space")).toMatchObject({ outcome: "whole" })
    const list = record.find((source) => source.kind === "index" && source.root !== "")
    expect(list).toMatchObject({
      root: "spaces/garden",
      listed: 2,
      folded: [],
      outcome: "whole",
      reason: null
    })
    const space = record.find((source) => source.kind === "space")
    expect((space?.bytes ?? 0) + (list?.bytes ?? 0) + 2).toBe(bytes(text ?? ""))
  })

  it("folds the Space's folder in the Memory index when the Space list is sent, so no line is sent twice", async () => {
    const beds = page("spaces/garden/beds.md", "Beds", "Raised beds.")
    const seeds = page("spaces/garden/seeds/list.md", "Seeds", "Seed list.")
    const pages = [...PAGES, beds, seeds]
    const lines = (text: string | undefined) =>
      new Set((text ?? "").split("\n").filter((line) => line.startsWith("- ")))
    const owner = await compose({ actor: person, spaceId: "space-1", pages })
    const index = owner.sections.find((section) => section.key === "Memory index")?.text
    const space = owner.sections.find((section) => section.key === "Current Space")?.text
    expect([...lines(index)].filter((line) => lines(space).has(line))).toEqual([])
    expect(index).toContain("- spaces/garden/ (folded)")
    expect(index).not.toContain("spaces/garden/beds.md")
    expect(
      owner.writes[0]?.sources.find((source) => source.kind === "index" && source.root === "")
    ).toMatchObject({
      folded: [{ folder: "spaces/garden", pages: 2 }],
      outcome: "whole",
      reason: null
    })
    const worker = await compose({
      actor: { kind: "task_worker", item_id: "t", space_id: "space-1" },
      spaceId: "space-1",
      pages
    })
    const workerIndex = worker.sections.find((section) => section.key === "Memory index")?.text
    expect(workerIndex).toContain("- spaces/garden/beds.md")
    expect(workerIndex).not.toContain("(folded)")
  })

  it("folds a long list of the Space's pages in its own allowance, with a notice", async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      page(`spaces/garden/beds/bed-${index}.md`, `Bed ${index}`, "A raised bed in the garden.")
    )
    const plain = await compose({ actor: person, spaceId: "space-1" })
    const composed = await compose({
      actor: person,
      spaceId: "space-1",
      pages: [...PAGES, ...many]
    })
    const text = composed.sections.find((section) => section.key === "Current Space")?.text ?? ""
    expect(text).toContain("spaces/garden/beds/ (folded)")
    expect(text).toContain("[Folded: a folder marked folded")
    const record = composed.writes[0]?.sources ?? []
    expect(record.find((source) => source.kind === "index" && source.root !== "")).toMatchObject({
      root: "spaces/garden",
      listed: 0,
      folded: [{ folder: "spaces/garden/beds", pages: 120 }],
      outcome: "cut",
      reason: "index_allowance"
    })
    expect(bytes(text)).toBeLessThanOrEqual(MEMORY_BUDGET.space + MEMORY_BUDGET.spacePageList)
    expect(record.find((source) => source.kind === "space")).toEqual(
      plain.writes[0]?.sources.find((source) => source.kind === "space")
    )
  })

  it("never recalls the Space page a second time", async () => {
    const composed = await compose({ actor: person, spaceId: "space-1" })
    const record = composed.writes[0]?.sources ?? []
    expect(record.filter((source) => source.page_id === spacePage.page.pageId)).toEqual([
      expect.objectContaining({ kind: "space" })
    ])
  })
})

describe("what an owner chat is sent and records", () => {
  it("records each source it was sent, and the record matches the prompt", async () => {
    const composed = await compose({ actor: person })
    const write = composed.writes.at(-1)
    const record = write?.sources ?? []
    expect({ ...write, sources: undefined }).toEqual({
      reader: "owner",
      revision: "rev-1",
      query: QUERY,
      budget: expect.any(Object),
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
      { kind: "index", root: "", listed: 3, folded: [], outcome: "whole", reason: null },
      ...[ledger, orchard, spacePage].map((page) => ({
        kind: "recalled",
        role: "knowledge",
        page_id: page.page.pageId,
        version: page.resource.versionId,
        outcome: "whole",
        reason: null
      }))
    ])
    expect(recordedBlocks(record, PAGES)).toEqual(blocksInPrompt(composed.sections))
    const index = composed.sections.find((section) => section.key === "Memory index")
    expect(record.find((source) => source.kind === "index")?.bytes).toBe(bytes(index?.text ?? ""))
    expect(index?.text).not.toContain("me.md")
  })

  it("says in each section that holds page text that it is context, not instructions", async () => {
    const composed = await compose({ actor: person })
    const sections = composed.sections.filter((section) =>
      ["Core Memory", "Memory index", "Memory context"].includes(section.key)
    )
    expect(sections).toHaveLength(3)
    for (const section of sections) expect(section.text).toMatch(/not (new )?instructions/u)
  })

  const turns = (...typed: ReadonlyArray<string>): ReadonlyArray<ChatRunnerMessage> =>
    typed.flatMap((content) => [
      { role: "user" as const, content },
      { role: "assistant" as const, content: "Which ledger?" }
    ])

  it("searches with the latest typed turn only, however short", async () => {
    const short = await compose({ actor: person, messages: turns(QUERY, "yes ok fine") })
    expect(short.searches).toEqual(["yes ok fine"])
    const question = "what did we decide about the second greenhouse"
    const later = await compose({ actor: person, messages: turns(QUERY, question) })
    expect(later.searches).toEqual([question])
  })

  it("keeps a long owner message once, as far as the word search read it", async () => {
    const long = `${QUERY} ${"pasted document text ".repeat(2_000)}`
    const composed = await compose({ actor: person, messages: [{ role: "user", content: long }] })
    const record = composed.writes.at(-1)
    expect(composed.searches).toEqual([long.trim()])
    expect(record?.query).toBe(recallQuery(long))
    expect(record?.query).toHaveLength(512)
    expect(JSON.stringify(record).length).toBeLessThan(2_000)
  })
})

describe("each source in its own allowance", () => {
  const many = (prefix: string, count: number, size: number) =>
    Array.from({ length: count }, (_, index) =>
      page(
        `${prefix}/page-${index}.md`,
        `Orchard ledger ${prefix} ${index}`,
        `${"Orchard lantern ledger notes. ".repeat(Math.ceil(size / 30))}`
      )
    )
  const sectionBytes = (composed: Composed, key: string) =>
    bytes(composed.sections.find((section) => section.key === key)?.text ?? "")
  const recallBytes = (composed: Composed) =>
    (composed.writes[0]?.sources ?? [])
      .filter((source) => source.kind === "recalled")
      .reduce((sum, source) => sum + source.bytes, 0)

  it("fits the index in 10,000 bytes, the Space in 10,000 and recall in 7,000, with 6,000 for its pages", async () => {
    const pages = [
      page("me.md", "Me", "Prefers short replies. ".repeat(380)),
      ...many("daily", 300, 9_000),
      ...many("notes", 40, 9_000)
    ]
    const composed = await compose({
      actor: person,
      pages,
      spaceId: "space-1",
      instructions: "Keep the garden ledger current. ".repeat(200)
    })
    expect(sectionBytes(composed, "Memory index")).toBeLessThanOrEqual(10_000)
    expect(sectionBytes(composed, "Current Space")).toBeLessThanOrEqual(10_000)
    expect(sectionBytes(composed, "Current Space")).toBeGreaterThan(4_000)
    expect(sectionBytes(composed, "Memory context")).toBeLessThanOrEqual(7_000)
    expect(recallBytes(composed)).toBeGreaterThanOrEqual(6_000)
    const recalled =
      composed.writes[0]?.sources.filter((source) => source.kind === "recalled") ?? []
    expect(recalled.map((source) => [source.outcome, source.reason])).toEqual([
      ["cut", "recall_allowance"],
      ["cut", "recall_allowance"],
      ["cut", "recall_allowance"]
    ])
  })

  it("sends both standing-facts pages whole at their writer limit, taking nothing from the rest", async () => {
    const atLimit = (path: string) =>
      page(path, path, `${"Prefers short replies. ".repeat(400).slice(0, 8_999)}.`)
    const small = await compose({ actor: person, pages: [core, ...many("notes", 3, 9_000)] })
    const full = [atLimit("me.md"), atLimit("profile.md")]
    expect(full.map((record) => record.page.body.trim().length)).toEqual([9_000, 9_000])
    const composed = await compose({ actor: person, pages: [...full, ...many("notes", 3, 9_000)] })
    const record = composed.writes[0]?.sources ?? []
    expect(record.filter((source) => source.kind === "core")).toEqual([
      expect.objectContaining({ outcome: "whole", reason: null }),
      expect.objectContaining({ outcome: "whole", reason: null })
    ])
    expect(recallBytes(composed)).toBe(recallBytes(small))
    expect(composed.sections.find((section) => section.key === "Memory index")?.text).not.toMatch(
      /profile\.md|me\.md/u
    )
  })

  it("sends a Space context whose instructions pass their share, cut with a notice", async () => {
    const composed = await compose({
      actor: person,
      spaceId: "space-1",
      instructions: "果林の記録を毎日更新する。".repeat(400)
    })
    const space = composed.sections.find((section) => section.key === "Current Space")?.text ?? ""
    expect(space).toContain("Space instructions:")
    expect(space).toContain("[Cut to fit: the rest of the Space instructions is left out.]")
    expect(bytes(space)).toBeLessThanOrEqual(MEMORY_BUDGET.space)
    expect(composed.writes[0]?.sources.find((source) => source.kind === "space")).toEqual(
      expect.objectContaining({ bytes: bytes(space), outcome: "whole", reason: null })
    )
  })

  const threeByteAtLimit = (path: string) =>
    page(path, path, `${"果".repeat(99)}\n`.repeat(90).trim())

  it("sends a standing-facts page at its writer limit whole, even in three-byte text", async () => {
    const wide = threeByteAtLimit("me.md")
    expect(wide.page.body.trim().length).toBe(8_999)
    const composed = await compose({ actor: person, pages: [wide, ...many("notes", 3, 9_000)] })
    const coreSource = composed.writes[0]?.sources.find((source) => source.kind === "core")
    expect(coreSource).toEqual(expect.objectContaining({ outcome: "whole", reason: null }))
    expect(coreSource?.bytes).toBeGreaterThan(26_000)
    expect(coreSource?.bytes).toBeLessThanOrEqual(MEMORY_BUDGET.standingPage)
  })

  it("keeps the whole block within the sum of its allowances", async () => {
    const composed = await compose({
      actor: person,
      spaceId: "space-1",
      instructions: "果林".repeat(3_000),
      pages: [
        threeByteAtLimit("me.md"),
        threeByteAtLimit("profile.md"),
        ...many("daily", 300, 9_000)
      ]
    })
    const total = composed.sections
      .filter((section) =>
        ["Core Memory", "Memory index", "Current Space", "Memory context"].includes(section.key)
      )
      .reduce((sum, section) => sum + bytes(section.text), 0)
    expect(total).toBeGreaterThan(2 * 26_000)
    expect(total).toBeLessThanOrEqual(MEMORY_BLOCK_MAX_BYTES)
  })

  it("cuts a standing-facts page past its writer limit at a boundary, with a notice", async () => {
    const pasted = page("me.md", "Me", "Prefers short replies.\n\n".repeat(1_700))
    const notes = many("notes", 3, 9_000)
    const composed = await compose({ actor: person, spaceId: "space-1", pages: [pasted, ...notes] })
    const record = composed.writes[0]?.sources ?? []
    const coreText = composed.sections.find((section) => section.key === "Core Memory")?.text ?? ""
    expect(coreText).toContain("Prefers short replies.\n\n[Partial page; use wiki_read_page")
    expect(record.map((source) => [source.kind, source.outcome, source.reason])).toEqual([
      ["core", "cut", "standing_page_allowance"],
      ["index", "whole", null],
      ["space", "whole", null],
      ["recalled", "cut", "recall_allowance"],
      ["recalled", "cut", "recall_allowance"],
      ["recalled", "cut", "recall_allowance"]
    ])
    expect(recordedBlocks(record, [pasted, ...notes])).toEqual(blocksInPrompt(composed.sections))
  })

  it("folds the index to fit its share, with a notice, and counts every page", async () => {
    const pages = [core, ...many("daily", 250, 40), ...many("notes", 20, 40)]
    const composed = await compose({ actor: person, pages })
    const index = composed.writes[0]?.sources.find((source) => source.kind === "index")
    const text = composed.sections.find((section) => section.key === "Memory index")?.text ?? ""
    expect(index).toMatchObject({
      kind: "index",
      listed: 20,
      folded: [{ folder: "daily", pages: 250 }],
      outcome: "cut",
      reason: "index_allowance"
    })
    expect(index?.bytes).toBeLessThanOrEqual(10_000)
    expect(text).toContain("- daily/ (folded)")
    expect(text).toContain("[Folded: a folder marked folded is not listed page by page")
    expect(text).not.toContain("250")
  })

  it("cuts the index from the end, with a notice, when folding alone does not fit it", async () => {
    const singles = Array.from({ length: 700 }, (_, index) =>
      page(`folder-${String(index).padStart(3, "0")}/only.md`, "Only", "")
    )
    const composed = await compose({
      actor: { kind: "task_worker", item_id: "t", space_id: "s" },
      pages: [core, ...singles]
    })
    const index = composed.writes[0]?.sources.find((source) => source.kind === "index")
    const text = composed.sections.find((section) => section.key === "Memory index")?.text ?? ""
    expect(index).toMatchObject({ outcome: "cut", reason: "index_allowance" })
    expect(bytes(text)).toBeLessThanOrEqual(10_000)
    expect(text).toContain("[Cut to fit: the last lines are left out")
  })

  it("recalls three pages at most", async () => {
    const composed = await compose({ actor: person, pages: [core, ...many("notes", 6, 300)] })
    expect(composed.writes[0]?.sources.filter((source) => source.kind === "recalled")).toHaveLength(
      3
    )
  })
})

describe("one owner for each limit and rule", () => {
  const root = join(import.meta.dirname, "../src")
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .toSorted()
  const offenders = (pattern: RegExp, allowed: ReadonlyArray<string>) =>
    files.filter(
      (relative) =>
        !allowed.includes(relative) && pattern.test(readFileSync(join(root, relative), "utf8"))
    )

  it("only the assembler builds Memory sections or gives a source its room", () => {
    expect(
      offenders(/"(Core Memory|Memory recall|Memory index|Current Space)"[^\n]*\)/u, [
        "context/memory-context.ts",
        "memory/index-render.ts",
        "memory/retrieval.ts"
      ])
    ).toEqual([])
    expect(
      offenders(/\brenderSpaceContext\(/u, ["context/memory-context.ts", "context/space-render.ts"])
    ).toEqual([])
    expect(
      offenders(/\.(index|recall)\??\.?\(\s*[\d_A-Z]/u, ["context/memory-context.ts"])
    ).toEqual([])
    expect(files.filter((file) => file.endsWith("continuity-budget.ts"))).toEqual([])
  })

  it("renders every generated page list, the Memory index and a Space's, in one renderer", () => {
    expect(
      offenders(/\bmemoryIndex\(/u, ["memory/index-render.ts", "wiki/collections.ts"])
    ).toEqual([])
    expect(offenders(/\[(Folded|Cut to fit: the last lines)/u, ["memory/index-render.ts"])).toEqual(
      []
    )
  })

  it("only core-memory.ts names the standing-facts pages", () => {
    expect(
      offenders(/["'`](me|profile)["'`]|\b(me|profile)\.md\b/u, [
        "memory/core-memory.ts",
        "wiki/foundation.ts"
      ])
    ).toEqual([])
  })
})

describe("the stored record", () => {
  const source = (pageId: string): RunMemorySource => ({
    kind: "recalled",
    role: "knowledge",
    page_id: pageId,
    version: "version-1",
    bytes: 120,
    outcome: "cut",
    reason: "recall_allowance"
  })
  const first: RunMemoryContext = {
    reader: "owner",
    revision: "rev-1",
    query: "a made-up question",
    sources: [source("page-a"), source("page-b")]
  }
  const steered: RunMemoryContext = {
    reader: "owner",
    revision: "rev-1",
    query: "a made-up steer",
    sources: [source("page-c")]
  }
  const none: RunMemoryContext = { reader: "worker", revision: null, query: null, sources: [] }

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

  it("records the budget each composition was made under, every allowance of it", async () => {
    const composed = await compose({ actor: person, spaceId: "space-1" })
    const budget = composed.writes[0]?.budget
    expect(budget).toEqual({
      standing_page: MEMORY_BUDGET.standingPage,
      standing_frame: MEMORY_BUDGET.standingFrame,
      index: MEMORY_BUDGET.index,
      space: MEMORY_BUDGET.space,
      space_instructions: MEMORY_BUDGET.spaceInstructions,
      space_page: MEMORY_BUDGET.spacePage,
      space_page_list: MEMORY_BUDGET.spacePageList,
      recall: MEMORY_BUDGET.recall
    })
    expect(Object.keys(budget ?? {})).toHaveLength(Object.keys(MEMORY_BUDGET).length)
    const decode = Schema.decodeUnknownSync(RunMemoryContextSchema)
    expect(decode(composed.writes[0])).toEqual(composed.writes[0])
    expect(decode(first)).toEqual(first)
  })

  it("never writes a retired value", () => {
    const encode = Schema.encodeUnknownSync(RunMemoryContextSchema)
    for (const retired of [
      { ...first, sources: [{ ...source("a"), kind: "collection" }] },
      { ...first, sources: [{ ...source("a"), reason: "continuity_budget" }] },
      { ...first, sources: [{ ...source("a"), reason: "block_budget" }] },
      { ...first, sources: [{ ...source("a"), reason: "core_page_budget" }] },
      { revision: null, query: null, sources: [] }
    ])
      expect(() => encode(retired)).toThrow()
  })
})
