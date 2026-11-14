import type { ToolContext } from "@arden-hq/loop"
import type { TaskProposal } from "@arden-hq/protocol/proposals"
import type {
  Commit,
  ManagedFileRepositoryShape,
  ResourceChange,
  ResourceVersion
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { SpaceReviewStore } from "../src/persistence/automations/space-review-store.js"
import type { SpaceReviewReads } from "../src/persistence/automations/space-review.js"
import {
  TaskProposalStore,
  type ProposeSpaceTaskInput
} from "../src/persistence/proposals/store.js"
import { assertCurrentTaskRevision } from "../src/persistence/sqlite/work-history.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import type { TaskInferenceReview } from "../src/persistence/work/inference.js"
import { WorkStore } from "../src/persistence/work/store.js"
import type { ServerTool } from "../src/tools/define.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { taskHandle } from "../src/tools/task-handle.js"
import { taskInferenceTools } from "../src/tools/task-inference.js"
import { hashInputPaths } from "../src/tools/tool-contract.js"
import { toolParametersJsonSchema } from "../src/tools/tool-json-schema.js"
import { wikiChangeTools } from "../src/tools/wiki-change.js"
import { makeWikiChangeMethods } from "../src/wiki/change.js"
import { Wiki } from "../src/wiki/service.js"
import type { PageRecord } from "../src/wiki/snapshot.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService, serverRunContext, sessionHeader } from "./kit.js"

// The model names a page, a Task or a Chat turn; the server keeps the versions.
// Both cases below failed in real runs while the model had to copy a hash.

const hash = (character: string): string => character.repeat(64)
const HEX_64 = /[0-9a-f]{64}/

const context = (run: ServerRunContext = serverRunContext()): ToolContext<ServerRunContext> => ({
  run,
  signal: new AbortController().signal,
  toolCallId: "call-fixture",
  messages: []
})

const named = (tools: ReadonlyArray<ServerTool>, name: string): ServerTool => {
  const tool = tools.find((candidate) => candidate.definition.name === name)
  if (tool === undefined) throw new Error(`Missing tool ${name}`)
  return tool
}

const hashInputsOf = (tools: ReadonlyArray<ServerTool>): ReadonlyArray<string> =>
  tools.flatMap((tool) =>
    hashInputPaths(tool.definition.name, tool.entry(toolParametersJsonSchema).parameters)
  )

describe("task_propose after a review", () => {
  const SPACE = "space-1"
  const offered: TaskProposal = {
    proposal_id: "task-proposal:p1",
    place: "space",
    space_id: SPACE,
    chat_session_id: null,
    stable_key: "reply-to-ana",
    text: "Reply to Ana",
    body: null,
    owner: "worker",
    capture: { basis: "inferred", reason: "Ana asked for a reply." },
    sources: [],
    signal: null,
    source_run_id: "run-fixture",
    source_session_id: "session-fixture",
    source_turn_id: "turn-1",
    source_tool_call_id: "call-fixture",
    capture_policy: { origin: "space", task_item_id: null, task_generation: null },
    revision: 1,
    status: "offered",
    retirement: null,
    item_id: null,
    put_off_until: null,
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z",
    settled_at: null
  }

  const fixture = () => {
    const state = { snapshot: hash("a") }
    const proposed: Array<ProposeSpaceTaskInput> = []
    const review = (): TaskInferenceReview => ({
      snapshot: state.snapshot,
      tasks: [
        { item_id: "task-1", text: "Ship it", status: "open", updated_at: "2026-11-04T09:00:00Z" }
      ],
      chats: [],
      proposals: [],
      rejections: []
    })
    const tools = Effect.runSync(
      taskInferenceTools.pipe(
        Effect.provideService(SpaceStore, partialService<SpaceStore["Service"]>("SpaceStore", {})),
        Effect.provideService(
          WorkStore,
          partialService<WorkStore["Service"]>("WorkStore", {
            inferenceReview: () => Effect.succeed(review())
          })
        ),
        Effect.provideService(
          TaskProposalStore,
          partialService<TaskProposalStore["Service"]>("TaskProposalStore", {
            propose: (input) => {
              proposed.push(input)
              return Effect.succeed(offered)
            }
          })
        ),
        Effect.provideService(
          SessionQueries,
          partialService<SessionQueries["Service"]>("SessionQueries", {
            loadHistoryHeader: () => Effect.succeed(sessionHeader({ spaceId: SPACE }))
          })
        ),
        Effect.provideService(Wiki, partialService<Wiki["Service"]>("Wiki", {}))
      )
    )
    return { state, proposed, tools }
  }

  const create = (sources: ReadonlyArray<Record<string, string>>) => ({
    sources,
    decision: {
      kind: "create",
      task: { key: "reply-to-ana", text: "Reply to Ana" },
      reason: "Ana asked for a reply and no Task owns it."
    }
  })
  const chatTurn = { kind: "chat", session_id: "session-2", turn_id: "turn-1" }

  it("takes no hash from the model", () => {
    expect(hashInputsOf(fixture().tools)).toEqual([])
  })

  it("is admitted against the review this run read, with no snapshot argument", async () => {
    const { state, proposed, tools } = fixture()
    const ctx = context()
    const reviewed = await named(tools, "space_inference_review").execute({}, ctx)
    expect(reviewed.content).not.toMatch(HEX_64)

    const result = await named(tools, "task_propose").execute(create([chatTurn]), ctx)

    expect(result.is_error).toBe(false)
    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.inferenceSnapshot).toBe(state.snapshot)
    expect(proposed[0]?.sources).toEqual([{ ...chatTurn, revision: "turn-1" }])
  })

  it("is refused before any review in this run", async () => {
    const { proposed, tools } = fixture()
    await expect(
      named(tools, "task_propose").execute(create([chatTurn]), context())
    ).rejects.toThrow(/space_inference_review first/)
    expect(proposed).toEqual([])
  })

  it("is refused when the Space changed after the review", async () => {
    const { state, tools } = fixture()
    const ctx = context()
    await named(tools, "space_inference_review").execute({}, ctx)
    state.snapshot = hash("b")
    await expect(
      named(tools, "task_propose").execute(
        {
          sources: [chatTurn],
          decision: { kind: "reuse", item_id: "task-1", reason: "Ship it already owns this." }
        },
        ctx
      )
    ).rejects.toThrow(/changed since review/)
  })

  it("cites a Task at the version this run read", async () => {
    const { proposed, tools } = fixture()
    const ctx = context()
    await named(tools, "space_inference_review").execute({}, ctx)
    const own = { kind: "task", item_id: "task-1" }
    await expect(named(tools, "task_propose").execute(create([own]), ctx)).rejects.toThrow(
      /Read the Task/
    )

    const shown = taskHandle(ctx.run, {
      item_id: "task-1",
      stable_key: "ship-it",
      updated_at: "2026-11-04T09:00:00Z",
      history_revision: "task-1:3"
    })
    expect(shown).not.toContain("task-1:3")
    await named(tools, "task_propose").execute(create([own]), ctx)
    expect(proposed[0]?.sources).toEqual([{ ...own, revision: "task-1:3" }])
  })

  // An old Task the history backfill has not reached has no saved version.
  it("cites a Task that has no saved history", async () => {
    const { proposed, tools } = fixture()
    const ctx = context()
    await named(tools, "space_inference_review").execute({}, ctx)
    taskHandle(ctx.run, {
      item_id: "task-1",
      stable_key: "ship-it",
      updated_at: "2026-11-04T09:00:00Z",
      history_revision: null
    })
    const own = { kind: "task", item_id: "task-1" }
    await named(tools, "task_propose").execute(create([own]), ctx)
    expect(proposed[0]?.sources).toEqual([{ ...own, revision: "task-1:0" }])
  })

  it("admits that Task until its first saved change", async () => {
    const AT = "2026-11-04T09:00:00.000Z"
    const admitted = (sql: SqlClient.SqlClient, itemId: string, revision: string) =>
      assertCurrentTaskRevision(sql, itemId, revision).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true })
      )
    const seen = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner,
            created_at, updated_at)
          VALUES ('task-1', NULL, 'ship-it', 'Ship it', 'open', 'worker', ${AT}, ${AT})`
        yield* sql`DELETE FROM space_task_revisions WHERE item_id = 'task-1'`
        const unsaved = yield* admitted(sql, "task-1", "task-1:0")
        const missing = yield* admitted(sql, "task-2", "task-2:0")
        yield* sql`UPDATE space_tasks SET text = 'Ship it today' WHERE item_id = 'task-1'`
        return {
          unsaved,
          missing,
          afterChange: yield* admitted(sql, "task-1", "task-1:0"),
          current: yield* admitted(sql, "task-1", "task-1:2")
        }
      })
    )
    expect(seen).toEqual({ unsaved: true, missing: false, afterChange: false, current: true })
  })
})

describe("wiki_read_change by page link", () => {
  const version = (resourceId: string, path: string, content: string): ResourceVersion => ({
    resourceId,
    path,
    blobId: hash(content),
    state: "active",
    versionId: hash(content)
  })
  const commit = (
    id: string,
    timestamp: string,
    changes: ReadonlyArray<ResourceChange>
  ): Commit => ({
    commitId: hash(id),
    parentId: null,
    treeId: hash(id),
    actor: "arden",
    origin: "filesystem",
    reason: `change ${id}`,
    timestamp,
    changes
  })
  const edit = (before: ResourceVersion | null, after: ResourceVersion | null): ResourceChange => ({
    action: before === null ? "create" : "update",
    before,
    after
  })

  const arden1 = version("arden", "projects/arden.md", "1")
  const arden2 = version("arden", "projects/arden.md", "2")
  const notes1 = version("notes", "projects/notes.md", "3")
  const gone1 = version("gone", "projects/gone.md", "4")
  const [plan1, plan2, plan3, plan4] = ["5", "6", "7", "8"].map((content) =>
    version("plan", "projects/plan.md", content)
  ) as [ResourceVersion, ResourceVersion, ResourceVersion, ResourceVersion]
  // Newest first, as the repository returns history.
  const commits = [
    commit("h", "2026-11-04T16:00:00.000000Z", [edit(plan3, plan4)]),
    commit("f", "2026-11-04T15:00:00.000000Z", [edit(plan2, plan3)]),
    commit("e", "2026-11-04T14:00:00.000000Z", [edit(plan1, plan2)]),
    commit("d", "2026-11-04T13:00:00.000000Z", [edit(null, plan1)]),
    commit("c", "2026-11-04T12:00:00.000000Z", [edit(null, notes1)]),
    commit("b", "2026-11-04T11:00:00.000000Z", [edit(arden1, arden2)]),
    commit("9", "2026-11-04T10:30:00.000000Z", [edit(null, gone1)]),
    commit("a", "2026-11-04T10:00:00.000000Z", [edit(null, arden1)])
  ]
  const page = (resource: ResourceVersion, title: string): PageRecord => ({
    resource,
    page: {
      pageId: resource.resourceId,
      title,
      aliases: [],
      lifecycle: "active",
      redirectTo: null,
      metadata: {},
      body: "",
      content: ""
    }
  })

  const position = (commitId: string | null | undefined, fallback: number): number =>
    commitId == null ? fallback : commits.findIndex((each) => each.commitId === commitId)
  const versionAt = (commitId: string | null, resourceId: string): ResourceVersion | null =>
    commitId === null
      ? null
      : (commits
          .slice(position(commitId, 0))
          .flatMap((each) => each.changes)
          .find((change) => change.after?.resourceId === resourceId)?.after ?? null)
  const diffText = (before: ResourceVersion | null, after: ResourceVersion | null): string =>
    `-${before?.versionId.slice(0, 1) ?? "nothing"}\n+${after?.versionId.slice(0, 1) ?? "nothing"}\n`

  const repository = partialService<ManagedFileRepositoryShape>("Repository", {
    history: (options) =>
      Effect.succeed(
        commits
          .slice(position(options?.start, 0), position(options?.stopBefore, commits.length))
          .filter(
            (each) =>
              options?.resourceId == null ||
              each.changes.some(
                (change) => (change.after ?? change.before)?.resourceId === options.resourceId
              )
          )
      ),
    diffPage: (base, head, resourceId) => {
      const before = versionAt(base, resourceId)
      const after = versionAt(head, resourceId)
      return Effect.succeed({
        resourceId,
        before,
        after,
        offset: 0,
        endOffset: 20,
        hasMore: false,
        unifiedDiff: diffText(before, after)
      })
    },
    diffVersionsPage: (before, after) =>
      Effect.succeed({
        offset: 0,
        endOffset: 20,
        hasMore: false,
        unifiedDiff: diffText(before, after)
      })
  })
  // The previous review ended after the plan page was created; three changes
  // to it were saved before this review. The notes page is new to the review.
  const REVIEW_RUN = "review-run"
  const reads: SpaceReviewReads = {
    space: { name: "Arden", instructions: null },
    openTasks: [],
    proposals: [],
    memory: { base: hash("d"), head: hash("h") },
    pages: [
      {
        pageId: "plan",
        path: "projects/plan.md",
        version: plan4.versionId,
        basis: "owned",
        previousVersion: plan1.versionId
      },
      {
        pageId: "notes",
        path: "notes.md",
        version: notes1.versionId,
        basis: "linked",
        previousVersion: null
      }
    ],
    chats: [],
    removed: [],
    items: []
  }
  const tools = Effect.runSync(
    wikiChangeTools.pipe(
      Effect.provideService(
        Wiki,
        partialService<Wiki["Service"]>("Wiki", {
          snapshot: () =>
            Effect.succeed({
              head: hash("c"),
              pages: [page(arden2, "Arden"), page(notes1, "Notes"), page(plan4, "Plan")]
            }),
          ...makeWikiChangeMethods(repository)
        })
      ),
      Effect.provideService(
        SpaceReviewStore,
        partialService<SpaceReviewStore["Service"]>("SpaceReviewStore", {
          reviewReads: (runId) => Effect.succeed(runId === REVIEW_RUN ? reads : undefined)
        })
      )
    )
  )
  const read = (args: Record<string, string>, runId = "chat-run") =>
    named(tools, "wiki_read_change").execute(args, context(serverRunContext({ runId })))

  it("takes no hash from the model", () => {
    expect(hashInputsOf(tools)).toEqual([])
  })

  it("opens the page's latest change and shows no hash", async () => {
    const result = await read({ page: "arden:memory/projects/arden.md" })
    expect(result.is_error).toBe(false)
    expect(result.content).toContain("Saved 2026-11-04T11:00:00.000000Z")
    expect(result.content).toContain("-1\n+2")
    expect(result.content).not.toMatch(HEX_64)
  })

  it("opens the change in effect at a listed time", async () => {
    const result = await read({
      page: "arden:memory/projects/arden.md",
      at: "2026-11-04T10:00:00.000000Z"
    })
    expect(result.content).toContain("Saved 2026-11-04T10:00:00.000000Z")
    expect(result.content).toContain("-nothing\n+1")
  })

  it("finds a page that is no longer in Memory by the path it had", async () => {
    const result = await read({ page: "projects/gone.md" })
    expect(result.content).toContain("Saved 2026-11-04T10:30:00.000000Z")
  })

  it("shows a Space review every change to a page since its previous review", async () => {
    const result = await read({ page: "arden:memory/projects/plan.md" }, REVIEW_RUN)
    expect(result.is_error).toBe(false)
    expect(result.content).toContain("saved 3 times since the previous review")
    for (const hour of ["14", "15", "16"])
      expect(result.content).toContain(`Saved 2026-11-04T${hour}:00:00.000000Z`)
    expect(result.content).not.toContain("Saved 2026-11-04T13:00:00.000000Z")
    expect(result.content).toContain("-5\n+8")
    expect(result.content).not.toMatch(HEX_64)
  })

  it("shows a Space review a page it has not seen before as added", async () => {
    const result = await read({ page: "arden:memory/notes.md" }, REVIEW_RUN)
    expect(result.content).toContain("new to this review")
    expect(result.content).toContain("-nothing\n+3")
  })

  it("opens only the latest change outside a review, or at a named time inside one", async () => {
    const latest = await read({ page: "arden:memory/projects/plan.md" })
    expect(latest.content).toContain("-7\n+8")
    const named = await read(
      { page: "arden:memory/projects/plan.md", at: "2026-11-04T15:00:00.000000Z" },
      REVIEW_RUN
    )
    expect(named.content).toContain("-6\n+7")
  })

  it("says how to list a page's changes when none matches", async () => {
    await expect(
      read({ page: "arden:memory/projects/arden.md", at: "2026-11-01T00:00:00Z" })
    ).rejects.toThrow(/wiki_page_history/)
  })
})
