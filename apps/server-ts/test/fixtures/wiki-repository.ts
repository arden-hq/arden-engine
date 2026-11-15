import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { Clock, Context, Effect, Exit, Layer, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ToolContext } from "@arden-hq/loop"
import { DateTime } from "effect"

import { WikiEmbeddingIndex } from "../../src/embedding/wiki-index.js"
import type { ChatRunRecord } from "../../src/persistence/runs/model.js"
import { RunQueries } from "../../src/persistence/runs/queries.js"
import { SessionQueries } from "../../src/persistence/sessions/queries.js"
import type { SpaceStore } from "../../src/persistence/spaces/store.js"
import type { ServerTool } from "../../src/tools/define.js"
import type { ServerRunContext } from "../../src/tools/run-context.js"
import { wikiOperationTools } from "../../src/tools/wiki-operations.js"
import { makeWikiChangeMethods } from "../../src/wiki/change.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../../src/wiki/authority.js"
import {
  commitWiki,
  createPage,
  updatePage,
  type WikiCommitOrigin,
  type WikiCommitPoint
} from "../../src/wiki/commit.js"
import { makeWikiHistoryMethods } from "../../src/wiki/history.js"
import { makeWikiListingMethods } from "../../src/wiki/listing.js"
import { makeWikiMutationMethods } from "../../src/wiki/mutations.js"
import { formatWikiPage } from "../../src/wiki/page.js"
import { makeWikiRestoreMethods } from "../../src/wiki/restore.js"
import { Wiki } from "../../src/wiki/service.js"
import { partialService, recordOf, serverRunContext, sessionHeader } from "../kit.js"

/** The real Wiki read, history, change, update and restore methods over a fresh repository on disk. */
export interface WikiRepositoryFixture {
  readonly repository: ManagedFileRepositoryShape
  readonly wiki: Wiki["Service"]
  /** Saves `body` as the page's whole body, creating the page on its first save. */
  readonly save: (input: {
    readonly pageId: string
    readonly path: string
    readonly body: string
    readonly origin: WikiCommitOrigin
    readonly actor?: string
  }) => Promise<void>
}

export const withWikiRepository = async <A>(
  use: (fixture: WikiRepositoryFixture) => Promise<A>
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-test-wiki-"))
  const scope = Effect.runSync(Scope.make())
  try {
    const repository = await Effect.runPromise(
      Layer.buildWithScope(managedFileRepositoryNodeLayer({ workingRoot: directory }), scope).pipe(
        Effect.map(Context.get(ManagedFileRepository))
      )
    )
    const listing = makeWikiListingMethods(repository)
    const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {})
    const wiki = partialService<Wiki["Service"]>("Wiki", {
      ...listing,
      ...makeWikiHistoryMethods(repository, listing.snapshot),
      ...makeWikiChangeMethods(repository),
      ...makeWikiRestoreMethods(repository, spaces, listing.read),
      ...makeWikiMutationMethods(repository, spaces, listing.read)
    })
    const clock = distinctMillisClock()
    const save: WikiRepositoryFixture["save"] = async ({ pageId, path, body, origin, actor }) => {
      const content = formatWikiPage({
        pageId,
        title: pageId,
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: {},
        body
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          const head = yield* repository.currentRevision
          const current = yield* repository.get(pageId)
          yield* commitWiki(
            withoutSpaces(repository),
            {
              actor: actor ?? "Agent",
              origin,
              authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
              reason: `save ${path}`,
              expectedRevision: head
            },
            [current === null ? createPage(pageId, path, content) : updatePage(current, content)]
          )
        }).pipe(Effect.provideService(Clock.Clock, clock))
      )
    }
    return await use({ repository, wiki, save })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}

const distinctMillisClock = (): Clock.Clock => {
  const real = Effect.runSync(Clock.clockWith(Effect.succeed))
  let last = 0
  const millis = (): number => {
    last = Math.max(real.currentTimeMillisUnsafe(), last + 1)
    return last
  }
  const nanos = (): bigint => BigInt(millis()) * 1_000_000n
  return {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) => real.sleep(duration)
  }
}

export const withoutSpaces = (repository: ManagedFileRepositoryShape): WikiCommitPoint => ({
  repository,
  spaces: { activeBindings: () => Effect.succeed([]), get: () => Effect.succeed(null) }
})

export const agentChat = (sessionId: string): WikiCommitOrigin => ({ kind: "agent", sessionId })
export const ownerEdit: WikiCommitOrigin = { kind: "user", via: "filesystem" }

const at = DateTime.makeUnsafe("2026-11-01T10:00:00Z")
const runRecord: ChatRunRecord = {
  runId: "run-fixture",
  sessionId: "session-fixture",
  turnId: "turn",
  status: "running",
  stopReason: null,
  startedAt: at,
  updatedAt: at,
  endedAt: null,
  lastSequence: null,
  metadata: {
    run_context: {
      origin: { kind: "chat", session_id: "session-fixture", turn_id: "turn" },
      task: null
    }
  },
  errorCode: null,
  errorMessage: null,
  clientId: null,
  modelId: null,
  reasoningEffort: null
}

export const wikiToolsOver = (wiki: Wiki["Service"]): ReadonlyArray<ServerTool> =>
  Effect.runSync(
    wikiOperationTools.pipe(
      Effect.provideService(
        RunQueries,
        partialService<RunQueries["Service"]>("RunQueries", {
          get: () => Effect.succeed(runRecord),
          cause: () => Effect.succeed({ automationId: undefined, wakeDepth: 0 })
        })
      ),
      Effect.provideService(
        WikiEmbeddingIndex,
        partialService<WikiEmbeddingIndex["Service"]>("WikiEmbeddingIndex", {})
      ),
      Effect.provideService(
        SessionQueries,
        partialService<SessionQueries["Service"]>("SessionQueries", {
          loadHistoryHeader: (sessionId) =>
            Effect.succeed(
              sessionId === undefined || sessionId === "gone"
                ? null
                : sessionHeader({ sessionId, publicRef: `chat~${sessionId}` })
            )
        })
      ),
      Effect.provideService(Wiki, wiki)
    )
  )

export const namedTool = (tools: ReadonlyArray<ServerTool>, name: string): ServerTool => {
  const tool = tools.find((candidate) => candidate.definition.name === name)
  if (tool === undefined) throw new Error(`Missing tool ${name}`)
  return tool
}

export const historyTimes = (output: unknown): ReadonlyArray<string> => {
  const entries = recordOf(recordOf(output)["data"])["entries"]
  if (!Array.isArray(entries)) throw new Error("expected history entries")
  return entries.map((entry) => {
    const timestamp = recordOf(entry)["timestamp"]
    if (typeof timestamp !== "string") throw new Error("expected an entry time")
    return timestamp
  })
}
