import type { ToolContext } from "@arden-hq/loop"
import type { TaskProposal } from "@arden-hq/protocol/proposals"
import type {
  Commit,
  ManagedFileRepositoryShape,
  ResourceChange,
  ResourceVersion
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { SpaceReviewStore } from "../src/persistence/automations/space-review-store.js"
import type { SpaceReviewReads } from "../src/persistence/automations/space-review.js"
import {
  TaskProposalStore,
  type ProposeSpaceTaskInput
} from "../src/persistence/proposals/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SpaceStore, type PersistedSpace } from "../src/persistence/spaces/store.js"
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
import { snapshotOf, type PageRecord } from "../src/wiki/snapshot.js"
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

const mainSpaceRow: PersistedSpace = {
  inference: { enabled: true },
  space_id: "main-space",
  name: "Main",
  instructions: null,
  instructions_source: null,
  page_id: null,
  page_path: null,
  mark: null,
  kind: "main",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  archived_at: null
}

describe("task_propose after a review", () => {
  const SPACE = "space-1"
  const offered: TaskProposal = {
    proposal_id: "task-proposal:p1",
    placement: { kind: "space", space_id: SPACE },
    stable_key: "reply-to-ana",
    text: "Reply to Ana",
    body: { kind: "plain" },
    owner: "worker",
    capture: { basis: "inferred", reason: "Ana asked for a reply." },
    sources: [],
    signal: { kind: "unsignalled" },
    origin: {
      kind: "run",
      run_id: "run-fixture",
      session_id: "session-fixture",
      turn_id: "turn-1",
      tool_call_id: "call-fixture"
    },
    revision: 1,
    status: "offered",
    put_off: { kind: "in_view" },
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z"
  }

  const fixture = (runSpaceId: string | null = SPACE) => {
    const state = { snapshot: hash("a") }
    const proposed: Array<ProposeSpaceTaskInput> = []
    const reviewedSpaces: Array<string> = []
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
        Effect.provideService(
          SpaceStore,
          partialService<SpaceStore["Service"]>("SpaceStore", {
            list: () => Effect.succeed([mainSpaceRow])
          })
        ),
        Effect.provideService(
          WorkStore,
          partialService<WorkStore["Service"]>("WorkStore", {
            inferenceReview: (spaceId) => {
              reviewedSpaces.push(spaceId)
              return Effect.succeed(review())
            }
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
            loadHistoryHeader: () => Effect.succeed(sessionHeader({ spaceId: runSpaceId }))
          })
        ),
        Effect.provideService(Wiki, partialService<Wiki["Service"]>("Wiki", {}))
      )
    )
    return { state, proposed, reviewedSpaces, tools }
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

  it("reads Main's work for a run with no Space and proposes against that review", async () => {
    const { state, proposed, reviewedSpaces, tools } = fixture(null)
    const ctx = context()
    const reviewed = await named(tools, "space_inference_review").execute({}, ctx)
    expect(reviewed.content).toContain("Ship it")
    await named(tools, "task_propose").execute(create([chatTurn]), ctx)
    expect(reviewedSpaces).toEqual(["main-space"])
    expect(proposed.map((input) => [input.spaceId, input.inferenceSnapshot])).toEqual([
      [undefined, state.snapshot]
    ])
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
    removed: []
  }
  const tools = Effect.runSync(
    wikiChangeTools.pipe(
      Effect.provideService(
        Wiki,
        partialService<Wiki["Service"]>("Wiki", {
          snapshot: () =>
            Effect.succeed(
              snapshotOf(hash("c"), [
                page(arden2, "Arden"),
                page(notes1, "Notes"),
                page(plan4, "Plan")
              ])
            ),
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
    const between = await read({
      page: "arden:memory/projects/arden.md",
      at: "2026-11-04T10:30:00.000000Z"
    })
    expect(between.content).toContain("Saved 2026-11-04T10:00:00.000000Z")
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
})
