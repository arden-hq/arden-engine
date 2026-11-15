import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@arden-hq/loop"
import { errorMessage } from "@arden-hq/std/errors"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { buildSpaceReviewInput } from "../src/automations/space-review-input.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { prepareMemorySources, recallCandidates } from "../src/memory/retrieval.js"
import { WikiEventOutbox } from "../src/persistence/automations/wiki-event-outbox.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import type {
  WikiRenameApprovalRecord,
  WikiRenameStore
} from "../src/persistence/wiki/rename-store.js"
import type { ServerTool } from "../src/tools/define.js"
import { memoryForgetTools } from "../src/tools/memory-forget.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { makeWikiPageHistoryTools } from "../src/tools/wiki-page-history.js"
import { searchPages } from "../src/tools/wiki-search.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { makeWikiChangeMethods } from "../src/wiki/change.js"
import { memoryIndex } from "../src/wiki/collections.js"
import {
  archivePage,
  commitOutsideChange,
  commitWiki,
  createPage,
  movePage,
  ownerInApp,
  requireCommitRules,
  updatePage,
  type WikiCommitIdentity,
  type WikiCommitOrigin
} from "../src/wiki/commit.js"
import { makeWikiContentStepMethods } from "../src/wiki/content-steps.js"
import type { WikiError } from "../src/wiki/errors.js"
import { makeWikiForgetMethods } from "../src/wiki/forgotten.js"
import { makeWikiHistoryMethods } from "../src/wiki/history.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { makeWikiMaintenanceMethods } from "../src/wiki/maintenance.js"
import { makeWikiMutationMethods } from "../src/wiki/mutations.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { memoryFindings } from "../src/wiki/page-shape.js"
import { WikiChangeSink } from "../src/wiki/publication.js"
import { makeWikiRenameMethods } from "../src/wiki/rename.js"
import { makeWikiRestoreMethods } from "../src/wiki/restore.js"
import { claimKey } from "../src/wiki/retraction.js"
import { Wiki } from "../src/wiki/service.js"
import { activeRunPages, type Snapshot } from "../src/wiki/snapshot.js"
import { partialService, recordOf, runAuthority, serverRunContext, sessionHeader } from "./kit.js"

const LINE = "Sam lives in the old town by the river."
const OTHER = "The town has two bridges and one market."
const TURN = { sessionId: "session-fixture", chat: "arden:session/chat~session-fixture" }

const identity = (origin: WikiCommitOrigin): WikiCommitIdentity => ({
  actor: "test",
  origin,
  reason: "test write"
})
const CAPTURE = identity({ kind: "capture", replayKey: undefined, sessionId: "chat-1" })
const AGENT = identity({ kind: "agent", sessionId: "chat-1" })
const TIDY = identity({ kind: "automation", automationId: "wiki-maintenance" })
const AUTOMATION = identity({ kind: "automation", automationId: "owner-automation" })
const OUTSIDE = identity({ kind: "user", via: "filesystem" })

const content = (pageId: string, body: string) =>
  formatWikiPage({
    pageId,
    title: pageId,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })

const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () => Effect.succeed([])
})

interface Memory {
  readonly root: string
  readonly repository: ManagedFileRepositoryShape
  readonly listing: ReturnType<typeof makeWikiListingMethods>
  readonly mutations: ReturnType<typeof makeWikiMutationMethods>
  readonly restores: ReturnType<typeof makeWikiRestoreMethods>
  readonly forgetting: ReturnType<typeof makeWikiForgetMethods>
  readonly page: (path: string) => Effect.Effect<Snapshot["pages"][number], unknown>
  readonly write: (
    path: string,
    body: string,
    commit: WikiCommitIdentity
  ) => Effect.Effect<WikiError | undefined, unknown>
}

const withMemory = async <A>(body: (memory: Memory) => Effect.Effect<A, unknown>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "arden-forget-"))
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        yield* commitWiki(repository, { ...ownerInApp("seed"), expectedRevision: null }, [
          createPage("root", "README.md", content("root", "Pages.")),
          createPage("people", "people/README.md", content("people", "People.")),
          createPage("places", "places/README.md", content("places", "Places.")),
          createPage("sam", "people/sam.md", content("sam", `${LINE}\n- Works at the bakery.\n`)),
          createPage("town", "places/town.md", content("town", `- ${LINE}\n${OTHER}\n`))
        ])
        const listing = makeWikiListingMethods(repository)
        const mutations = makeWikiMutationMethods(repository, spaces, listing.read)
        const page = (path: string) =>
          listing.snapshot().pipe(
            Effect.flatMap((snapshot) => {
              const record = snapshot.wholeSet.find((candidate) => candidate.resource.path === path)
              return record === undefined
                ? Effect.die(`${path} is missing`)
                : Effect.succeed(record)
            })
          )
        const write = (path: string, text: string, commit: WikiCommitIdentity) =>
          Effect.gen(function* () {
            const record = yield* page(path)
            return yield* refusal(
              mutations.update({
                pageId: record.page.pageId,
                content: content(record.page.pageId, text),
                expectedVersion: record.resource.versionId,
                expectedHead: (yield* listing.head()) ?? "",
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
                commit
              })
            )
          })
        return yield* body({
          root,
          repository,
          listing,
          mutations,
          restores: makeWikiRestoreMethods(repository, spaces, listing.read),
          forgetting: makeWikiForgetMethods(repository),
          page,
          write
        })
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<A>
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onFailure: (error): E | undefined => error,
    onSuccess: () => undefined
  })

const refusedFor = (error: unknown): string | undefined => {
  const message = recordOf(error)["message"]
  if (typeof message !== "string") return undefined
  return message.includes("entry 1 in forgotten.md") ? "retraction" : message
}

const forget = (memory: Memory) =>
  memory.forgetting.forget({
    lines: [LINE],
    claim: "Sam does not live in the old town",
    turn: TURN
  })

describe("forgetting a line", () => {
  it("removes every copy on every page in one commit and opens the entry", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        const before = (yield* memory.repository.history({ limit: null })).length
        const change = yield* forget(memory)
        const after = (yield* memory.repository.history({ limit: null })).length
        const forgotten = yield* memory.page("forgotten.md")
        return {
          commits: after - before,
          sam: (yield* memory.page("people/sam.md")).page.body,
          town: (yield* memory.page("places/town.md")).page.body,
          stored: forgotten.page.metadata["retractions"],
          changed: change.pages.map((page) => page.path)
        }
      })
    )
    expect(outcome).toEqual({
      commits: 1,
      sam: "- Works at the bakery.\n",
      town: `${OTHER}\n`,
      stored: [
        {
          id: 1,
          status: "open",
          said: { chat: TURN.chat, at: expect.any(String) },
          claim: "Sam does not live in the old town",
          removed: [
            { path: "people/sam.md", line: LINE },
            { path: "places/town.md", line: `- ${LINE}` }
          ]
        }
      ],
      changed: ["people/sam.md", "places/town.md", "forgotten.md"]
    })
  })

  it("refuses a line of fewer than four words, which carries no claim", async () => {
    const error = await withMemory((memory) =>
      refusal(
        memory.forgetting.forget({ lines: ["- Works here."], claim: "Wrong job", turn: TURN })
      )
    )
    expect(error?.message).toBe(
      "Line 1 has fewer than 4 words, so it carries no claim to guard. Pass whole page lines."
    )
  })

  it("refuses every writer but the owner that would put the line back, naming the entry", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        const beforeForget = yield* memory.listing.head()
        yield* forget(memory)
        const back = `${OTHER}\n- sam lives in the OLD town by the [[places/town.md|river]].\n`
        const capture = yield* memory.write("places/town.md", back, CAPTURE)
        const agentPatch = yield* memory.write("places/town.md", back, AGENT)
        const tidyMerge = yield* memory.write("places/town.md", back, TIDY)
        const automation = yield* refusal(
          memory.mutations.create({
            path: "places/river.md",
            title: "River",
            body: `${LINE}\n`,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: AUTOMATION
          })
        )
        const sam = yield* memory.page("people/sam.md")
        const restoreTo = (yield* memory.repository.history({
          resourceId: "sam",
          start: beforeForget,
          limit: 1
        }))[0]?.commitId
        const restore = yield* refusal(
          memory.restores.restoreRevision({
            pageId: "sam",
            commitId: restoreTo ?? "",
            expectedVersion: sam.resource.versionId,
            expectedHead: (yield* memory.listing.head()) ?? "",
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: AGENT
          })
        )
        const move = yield* refusal(
          commitWiki(
            memory.repository,
            { ...AGENT, expectedRevision: yield* memory.listing.head() },
            [movePage(sam.resource, "people/samuel.md", content("sam", `${LINE}\n`))]
          )
        )
        const step = yield* refusal(
          makeWikiContentStepMethods(memory.repository).applyContentStep({
            name: "test-step",
            reason: "test content step",
            rewrite: (pages) =>
              Effect.succeed({
                pages: pages.map((page) =>
                  page.path === "people/sam.md" ? { ...page, body: `${page.body}${LINE}\n` } : page
                ),
                redirects: []
              })
          })
        )
        return {
          capture: refusedFor(capture),
          agentPatch: refusedFor(agentPatch),
          tidyMerge: refusedFor(tidyMerge),
          automation: refusedFor(automation),
          restore: refusedFor(restore),
          move: refusedFor(move),
          step: refusedFor(step)
        }
      })
    )
    expect(outcome).toEqual({
      capture: "retraction",
      agentPatch: "retraction",
      tidyMerge: "retraction",
      automation: "retraction",
      restore: "retraction",
      move: "retraction",
      step: "retraction"
    })
  })

  it("lets a Space be named like a forgotten line, and its page be made", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        const heading = content("space", `# ${LINE}\n\n## Open loops\n\n## Related\n`)
        const make = (commit: WikiCommitIdentity, path: string) =>
          Effect.gen(function* () {
            return yield* refusal(
              commitWiki(
                memory.repository,
                { ...commit, expectedRevision: yield* memory.listing.head() },
                [createPage(path, path, heading)]
              )
            )
          })
        return {
          spacePage: yield* make(identity({ kind: "space_page" }), "areas/space.md"),
          capture: refusedFor(yield* make(CAPTURE, "areas/other.md"))
        }
      })
    )
    expect(outcome).toEqual({ spacePage: undefined, capture: "retraction" })
  })

  it("lets the owner put a line back, in the app or in the file, and keeps it there", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        const inApp = yield* memory.write(
          "people/sam.md",
          `${LINE}\n- Works at the bakery.\n`,
          ownerInApp("owner edit")
        )
        const inFile = yield* memory.write("places/town.md", `${OTHER}\n${LINE}\n`, OUTSIDE)
        const laterCapture = yield* memory.write(
          "people/sam.md",
          `${LINE}\n- Works at the bakery on weekdays.\n`,
          CAPTURE
        )
        return { inApp, inFile, laterCapture }
      })
    )
    expect(outcome).toEqual({ inApp: undefined, inFile: undefined, laterCapture: undefined })
  })

  it("lets only the owner and Arden's own code write forgotten.md", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        const forgotten = yield* memory.page("forgotten.md")
        const agent = yield* refusal(
          commitWiki(
            memory.repository,
            { ...AGENT, expectedRevision: yield* memory.listing.head() },
            [updatePage(forgotten.resource, `${forgotten.page.content}\nClosed by an agent.\n`)]
          )
        )
        return recordOf(agent)["message"]
      })
    )
    expect(outcome).toBe(
      "forgotten.md is kept by Arden for the owner. Nothing was saved; leave it unchanged."
    )
  })

  it("keeps an entry the owner wrote that does not read when it adds the next", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        const forgotten = yield* memory.page("forgotten.md")
        const stored = forgotten.page.metadata["retractions"]
        const handWritten = { note: "written by hand" }
        yield* commitWiki(
          memory.repository,
          { ...OUTSIDE, expectedRevision: yield* memory.listing.head() },
          [
            updatePage(
              forgotten.resource,
              formatWikiPage({
                ...forgotten.page,
                metadata: {
                  ...forgotten.page.metadata,
                  retractions: [...(Array.isArray(stored) ? stored : []), handWritten]
                }
              })
            )
          ]
        )
        const ferry = "The ferry runs from the east bank."
        yield* memory.write("places/town.md", `${OTHER}\n${ferry}\n`, OUTSIDE)
        const next = yield* memory.forgetting.forget({
          lines: [ferry],
          claim: "There is no ferry",
          turn: TURN
        })
        const after = (yield* memory.page("forgotten.md")).page
        const kept = after.metadata["retractions"]
        return {
          next: next.entry.id,
          kept: Array.isArray(kept) ? kept.length : 0,
          handWritten:
            Array.isArray(kept) && kept.some((entry) => recordOf(entry)["note"] !== undefined),
          noted: after.body.includes("1 entry in this page's frontmatter does not read")
        }
      })
    )
    expect(outcome).toEqual({ next: 2, kept: 3, handWritten: true, noted: true })
  })

  it("lets the line be written again once the entry is undone", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        const undone = yield* memory.forgetting.undoForget({ id: 1, turn: TURN })
        const capture = yield* memory.write("places/town.md", `${OTHER}\n${LINE}\n`, CAPTURE)
        const again = yield* refusal(memory.forgetting.undoForget({ id: 1, turn: TURN }))
        return { status: undone.entry.status, capture, again: again?.message }
      })
    )
    expect(outcome).toEqual({
      status: "closed",
      capture: undefined,
      again: "No entry 1 is open; nothing is forgotten now."
    })
  })

  it("keeps forgotten.md out of recall, search, the index, page lists and upkeep", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        const beforeForget = yield* memory.listing.head()
        yield* forget(memory)
        const afterForget = yield* memory.listing.head()
        yield* memory.forgetting.undoForget({ id: 1, turn: TURN })
        const snapshot = yield* memory.listing.snapshot()
        const query = "sam does not live in the old town river forgotten"
        const prepared = prepareMemorySources({
          pages: snapshot.pages,
          recall: recallCandidates({
            pages: snapshot.pages,
            query: query,
            today: "2026-11-15",
            sentElsewhere: new Set()
          }),
          lastChanged: new Map()
        })
        const upkeep = makeWikiMaintenanceMethods(memory.repository)
        const forgetRange = yield* upkeep.prepare({
          processedHead: beforeForget
        })
        const undoRange = yield* upkeep.prepare({
          processedHead: afterForget
        })
        const indexText = prepared.render(new Map()).index(100_000).text ?? ""
        const linking = yield* memory.page("places/town.md")
        yield* memory.write("places/town.md", `${OTHER}\nSee [[forgotten]].\n`, ownerInApp("link"))
        const review = buildSpaceReviewInput(yield* memory.listing.snapshot())({
          spaceId: "space-1",
          pageId: linking.page.pageId,
          pagePath: linking.resource.path,
          memorySources: [],
          semantic: JSON.stringify({
            space: JSON.stringify({ instructions: null, inference_policy: null }),
            tasks: []
          }),
          chats: [],
          items: [],
          openProposals: [],
          space: undefined,
          asked: false
        })
        return {
          findings: memoryFindings({ pages: snapshot.pages, untracked: [] }).filter((finding) =>
            finding.paths.includes("forgotten.md")
          ),
          reviewed: review.pages.some((page) => page.path === "forgotten.md"),
          stored: snapshot.wholeSet.some((record) => record.resource.path === "forgotten.md"),
          recalled: prepared.recalled
            .map((record) => record.resource.path)
            .includes("forgotten.md"),
          searched: searchPages(activeRunPages(snapshot.pages), query, 20)
            .map((match) => match.record.resource.path)
            .includes("forgotten.md"),
          indexed: memoryIndex(snapshot.pages, { root: "", maxBytes: 100_000 })
            .lines.map((line) => line.path)
            .includes("forgotten.md"),
          sentIndex: indexText.includes("forgotten.md"),
          forgetRange:
            forgetRange.kind === "review"
              ? forgetRange.markdown.includes("forgotten.md")
              : forgetRange.kind,
          undoRange: undoRange.kind
        }
      })
    )
    expect(outcome).toEqual({
      findings: [],
      reviewed: false,
      stored: true,
      recalled: false,
      searched: false,
      indexed: false,
      sentIndex: false,
      forgetRange: false,
      undoRange: "advance"
    })
  })
})

const renameStore = (): WikiRenameStore["Service"] => {
  const rows = new Map<string, WikiRenameApprovalRecord>()
  const set = (approvalId: string, change: Partial<WikiRenameApprovalRecord>) =>
    Effect.suspend(() => {
      const row = rows.get(approvalId)
      if (row === undefined) return Effect.die(`${approvalId} is missing`)
      const next = { ...row, ...change }
      rows.set(approvalId, next)
      return Effect.succeed(next)
    })
  return partialService<WikiRenameStore["Service"]>("WikiRenameStore", {
    createOrGet: (input) =>
      Effect.sync(() => {
        const row: WikiRenameApprovalRecord = {
          ...input,
          status: "pending",
          createdAt: "2026-11-15T00:00:00.000Z",
          commitId: null,
          resolution: null
        }
        rows.set(input.approvalId, row)
        return row
      }),
    get: (approvalId) => Effect.sync(() => rows.get(approvalId) ?? null),
    beginApply: (approvalId) => set(approvalId, { status: "applying" }),
    finishApply: (approvalId, commitId) => set(approvalId, { status: "accepted", commitId }),
    releaseApply: (approvalId, resolution) =>
      set(approvalId, { status: "pending", resolution: resolution ?? null })
  })
}

const LINKED = "Sam works with [[places/town.md|Town]] council every week."

describe("what forgotten.md holds and where it stays", () => {
  it("holds no link, so a run can still rename a page a forgotten line linked to", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* memory.write("people/sam.md", `${LINKED}\n- Works at the bakery.\n`, ownerInApp("x"))
        yield* memory.forgetting.forget({
          lines: [LINKED],
          claim: "Not on the council",
          turn: TURN
        })
        const history = makeWikiHistoryMethods(memory.repository, memory.listing.snapshot)
        const backlinks = (yield* history.links("town")).backlinks.map((link) => link.sourcePageId)
        yield* memory.forgetting.undoForget({ id: 1, turn: TURN })
        const renames = makeWikiRenameMethods(memory.repository, spaces, renameStore())
        const town = yield* memory.page("places/town.md")
        const requested = yield* renames.requestRename({
          pageId: "town",
          newPath: "places/city.md",
          newTitle: "City",
          expectedVersion: town.resource.versionId,
          expectedHead: (yield* memory.listing.head()) ?? "",
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: AGENT
        })
        const accepted = yield* renames.acceptRename({
          approvalId: requested.approvalId,
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: AGENT
        })
        return { backlinks, status: accepted.status, resolution: accepted.resolution }
      })
    )
    expect(outcome).toEqual({ backlinks: [], status: "accepted", resolution: null })
  })

  it("shows each entry's chat as a link and its date, and says the page is rebuilt", async () => {
    const body = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        return (yield* memory.page("forgotten.md")).page.body
      })
    )
    expect(body).toMatch(
      new RegExp(`Open\\. Asked in \\[a chat\\]\\(${TURN.chat}\\) on \\d{4}-\\d{2}-\\d{2}\\.`, "u")
    )
    expect(body).toContain("Arden rewrites this page from its entries")
    expect(body).toContain("stay in each page's history")
  })

  it("keeps forgotten.md at its path for every writer, the owner too", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        const head = () => memory.listing.head()
        const madeByHand = yield* refusal(
          commitWiki(memory.repository, { ...ownerInApp("x"), expectedRevision: yield* head() }, [
            createPage("by-hand", "forgotten.md", content("by-hand", "Made by hand."))
          ])
        )
        yield* forget(memory)
        const forgotten = yield* memory.page("forgotten.md")
        const moved = yield* refusal(
          commitWiki(memory.repository, { ...ownerInApp("x"), expectedRevision: yield* head() }, [
            movePage(forgotten.resource, "forgotten-things.md")
          ])
        )
        const archived = yield* refusal(
          commitWiki(memory.repository, { ...ownerInApp("x"), expectedRevision: yield* head() }, [
            archivePage(forgotten.resource)
          ])
        )
        const redirected = yield* refusal(
          commitWiki(memory.repository, { ...ownerInApp("x"), expectedRevision: yield* head() }, [
            updatePage(
              forgotten.resource,
              formatWikiPage({
                pageId: forgotten.page.pageId,
                title: "Forgotten",
                aliases: [],
                lifecycle: "redirect",
                redirectTo: "town",
                metadata: {},
                body: ""
              })
            )
          ])
        )
        const edited = yield* refusal(
          commitWiki(memory.repository, { ...ownerInApp("x"), expectedRevision: yield* head() }, [
            updatePage(forgotten.resource, `${forgotten.page.content}\nA note of mine.\n`)
          ])
        )
        yield* Effect.promise(() => rm(join(memory.root, "forgotten.md")))
        const kept = yield* memory.page("forgotten.md")
        const deleted = yield* refusal(
          commitOutsideChange(
            memory.repository,
            { ...OUTSIDE, expectedRevision: yield* head() },
            { kind: "missing", resource: kept.resource }
          )
        )
        const capture = yield* memory.write("places/town.md", `${OTHER}\n${LINE}\n`, CAPTURE)
        const message = (error: unknown) => recordOf(error)["message"]
        return {
          madeByHand: message(madeByHand),
          moved: message(moved),
          archived: message(archived),
          redirected: message(redirected),
          edited,
          deleted: message(deleted),
          capture: refusedFor(capture)
        }
      })
    )
    const kept =
      "forgotten.md is where Arden keeps what the owner asked to forget, so it cannot be made, moved, renamed, merged or archived by hand. " +
      "Nothing was saved. To let a line back, undo its entry in a chat or delete the entry from the page."
    expect(outcome).toEqual({
      madeByHand: kept,
      moved: kept,
      archived: kept,
      redirected: kept,
      edited: undefined,
      deleted: kept,
      capture: "retraction"
    })
  })
})

describe("comparing lines", () => {
  it("counts words, not table pipes, and reads text written without spaces", () => {
    expect({
      table: claimKey("| Name | Role |"),
      japanese: claimKey("私は東京に住んでいます。"),
      noPeriod: claimKey("Sam lives in the old town by the river"),
      withPeriod: claimKey(`- ${LINE}`)
    }).toEqual({
      table: undefined,
      japanese: "私 は 東京 に 住 んで い ます",
      noPeriod: "sam lives in the old town by the river",
      withPeriod: "sam lives in the old town by the river"
    })
  })
})

describe("no run is sent forgotten.md", () => {
  it("leaves it out of the changes a run lists and reads, and out of page history", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        yield* memory.forgetting.undoForget({ id: 1, turn: TURN })
        const changes = makeWikiChangeMethods(memory.repository)
        const read = yield* changes.readChange({
          path: "people/sam.md",
          pageId: "sam",
          at: undefined,
          offset: 0
        })
        const direct = yield* refusal(
          changes.readChange({ path: "forgotten.md", pageId: undefined, at: undefined, offset: 0 })
        )
        const listed = yield* memory.listing.listChanges({
          since: "2000-01-01T00:00:00.000Z",
          offset: 0,
          limit: 10
        })
        const [historyTool] = makeWikiPageHistoryTools({
          wiki: partialService<Wiki["Service"]>("Wiki", { snapshot: memory.listing.snapshot }),
          runs: partialService("RunQueries", {}),
          sessions: partialService("SessionQueries", {})
        })
        const history = yield* Effect.promise(() =>
          Promise.resolve(
            historyTool?.execute(
              { path: "forgotten.md", limit: 20 },
              {
                run: serverRunContext(),
                signal: new AbortController().signal,
                toolCallId: "call-fixture",
                messages: []
              }
            )
          ).then(
            () => "read",
            (error: unknown) => errorMessage(error)
          )
        )
        return {
          read: read.pages.map((page) => page.path).toSorted(),
          diffs: read.diffs.map((diff) => diff.path).toSorted(),
          direct: direct?.reason,
          listed: listed.entries.map((entry) => entry.changes.length),
          listedSystem: listed.entries.some((entry) =>
            entry.changes.some((change) => change.path === "forgotten.md")
          ),
          history: history.startsWith("No active wiki page exists at 'forgotten.md'")
        }
      })
    )
    expect(outcome).toEqual({
      read: ["people/sam.md", "places/town.md"],
      diffs: ["people/sam.md", "places/town.md"],
      direct: "not_found",
      listed: [2, 5],
      listedSystem: false,
      history: true
    })
  })

  it("leaves it out of content steps, upkeep's review pages and change announcements", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        yield* forget(memory)
        const stepped: Array<string> = []
        yield* makeWikiContentStepMethods(memory.repository).applyContentStep({
          name: "test-step",
          reason: "test content step",
          rewrite: (pages) =>
            Effect.sync(() => {
              stepped.push(...pages.map((page) => page.path))
              return { pages, redirects: [] }
            })
        })
        const beforeLink = yield* memory.listing.head()
        yield* memory.write(
          "places/town.md",
          `${OTHER}\nSee [[forgotten.md]] for what was taken out.\n`,
          ownerInApp("x")
        )
        const review = yield* makeWikiMaintenanceMethods(memory.repository).prepare({
          processedHead: beforeLink
        })
        const announced: Array<unknown> = []
        yield* Effect.gen(function* () {
          const sink = yield* WikiChangeSink
          for (const paths of [["forgotten.md"], ["forgotten.md", "people/sam.md"]])
            yield* sink.publish({
              previousRevision: null,
              revision: "a".repeat(64),
              savedAt: "2026-11-15T00:00:00.000Z",
              paths,
              origin: { kind: "forget", sessionId: TURN.sessionId },
              hasSpacePage: false
            })
        }).pipe(
          Effect.provide(
            automationWikiChangeSinkLayer.pipe(
              Layer.provide(
                Layer.succeed(
                  WikiEventOutbox,
                  partialService<WikiEventOutbox["Service"]>("WikiEventOutbox", {
                    publishWikiChange: (input) =>
                      Effect.sync(() => {
                        announced.push(
                          input.event === undefined
                            ? undefined
                            : recordOf(recordOf(input.event.context)["change"])["paths"]
                        )
                        return null
                      })
                  })
                )
              )
            )
          )
        )
        return {
          stepped: stepped.includes("forgotten.md"),
          reviewed:
            review.kind === "review" ? review.markdown.includes("- forgotten.md — ") : review.kind,
          announced
        }
      })
    )
    expect(outcome).toEqual({
      stepped: false,
      reviewed: false,
      announced: [undefined, ["people/sam.md"]]
    })
  })

  it("refuses a run that would restore an archived page holding a forgotten line", async () => {
    const outcome = await withMemory((memory) =>
      Effect.gen(function* () {
        const river = "The river floods the lower town every spring."
        yield* commitWiki(
          memory.repository,
          { ...ownerInApp("x"), expectedRevision: yield* memory.listing.head() },
          [createPage("river", "places/river.md", content("river", `${river}\n${LINE}\n`))]
        )
        const made = yield* memory.page("places/river.md")
        yield* commitWiki(
          memory.repository,
          { ...ownerInApp("x"), expectedRevision: yield* memory.listing.head() },
          [archivePage(made.resource)]
        )
        yield* forget(memory)
        const archived = yield* memory.repository.get("river")
        const restored = yield* refusal(
          memory.restores.restoreArchived({
            pageId: "river",
            expectedVersion: archived?.versionId ?? "",
            expectedHead: (yield* memory.listing.head()) ?? "",
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: AGENT
          })
        )
        return refusedFor(restored)
      })
    )
    expect(outcome).toBe("retraction")
  })

  it("words a size refusal for the owner's own forget as it does for the owner", async () => {
    const message = await withMemory((memory) =>
      requireCommitRules(memory.repository, { kind: "forget", sessionId: TURN.sessionId }, [
        createPage("me", "me.md", content("me", `${"word ".repeat(2_000)}\n`))
      ]).pipe(
        Effect.flip,
        Effect.map((error) => error.message)
      )
    )
    expect(message).toMatch(/Nothing was saved\. Shorten it by at least \d+ characters\.$/u)
  })
})

describe("memory_forget", () => {
  const context = (run: ServerRunContext): ToolContext<ServerRunContext> => ({
    run,
    signal: new AbortController().signal,
    toolCallId: "call-fixture",
    messages: []
  })

  const withTool = (use: (tool: ServerTool) => Effect.Effect<unknown, unknown>) =>
    withMemory((memory) =>
      Effect.gen(function* () {
        const tools = yield* memoryForgetTools.pipe(
          Effect.provideService(Wiki, partialService<Wiki["Service"]>("Wiki", memory.forgetting)),
          Effect.provideService(
            SessionQueries,
            partialService<SessionQueries["Service"]>("SessionQueries", {
              loadHistoryHeader: () => Effect.succeed(sessionHeader())
            })
          )
        )
        const tool = tools.find((candidate) => candidate.definition.name === "memory_forget")
        if (tool === undefined) throw new Error("memory_forget is missing")
        return yield* use(tool)
      })
    )

  it("forgets and undoes only in the owner's own turn", async () => {
    const outcome = await withTool((tool) =>
      Effect.gen(function* () {
        const run = (input: Readonly<Record<string, unknown>>, owner: boolean) =>
          Effect.promise(() =>
            Promise.resolve(
              tool.execute(
                input,
                context(
                  serverRunContext(
                    owner
                      ? {}
                      : {
                          authority: runAuthority({
                            actor: { kind: "space_review", space_id: "space-1" }
                          })
                        }
                  )
                )
              )
            ).then(
              () => "done",
              (error: unknown) => {
                const message = errorMessage(error)
                return message.includes("user's own turn") ? "refused" : message
              }
            )
          )
        const forgotten = yield* run({ lines: [LINE], claim: "Sam moved away" }, true)
        const undoByReview = yield* run({ undo: 1 }, false)
        const undone = yield* run({ undo: 1 }, true)
        const short = yield* run({ lines: ["- Works here."], claim: "Wrong job" }, true)
        return [forgotten, undoByReview, undone, short]
      })
    )
    expect(outcome).toEqual([
      "done",
      "refused",
      "done",
      "Line 1 has fewer than 4 words, so it carries no claim to guard. Pass whole page lines."
    ])
  })

  it("always asks, and the card says how many pages each line is on", async () => {
    const outcome = await withTool((tool) =>
      Effect.gen(function* () {
        const counted = yield* Effect.promise(() =>
          Promise.resolve(
            tool.definition.approvalPrompt?.(
              { lines: [LINE], claim: "Sam moved away" },
              context(serverRunContext())
            )
          ).then((prompt) => recordOf(recordOf(prompt)["presentation"])["fields"])
        )
        return { alwaysAsks: toolFacts(tool.definition).always_ask, counted }
      })
    )
    expect(outcome).toEqual({
      alwaysAsks: true,
      counted: [
        {
          label: "Pages per line",
          value: `${LINE}: 2 pages`
        }
      ]
    })
  })
})
