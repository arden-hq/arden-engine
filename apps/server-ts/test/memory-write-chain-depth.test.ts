import { readdirSync, readFileSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { DateTime, Effect } from "effect"
import { expect, it } from "vitest"

import type { ChatRunRecord } from "../src/persistence/runs/model.js"
import type { RunQueries } from "../src/persistence/runs/queries.js"
import { writeIdentity } from "../src/tools/wiki-identity.js"
import {
  commitWiki,
  createPage,
  decodeWikiOrigin,
  type WikiCommitOrigin
} from "../src/wiki/commit.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { partialService, runAuthority } from "./kit.js"

const AT = DateTime.makeUnsafe("2026-11-01T10:00:00Z")

/** The origin each write stored in Memory history, read back as the change publisher reads it. */
const storedOrigins = (origins: ReadonlyArray<WikiCommitOrigin>) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "arden-write-depth-")))
    return yield* Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const stored: Array<WikiCommitOrigin> = []
      for (const [index, origin] of origins.entries()) {
        const path = `notes/made-up-${index}.md`
        yield* commitWiki(
          repository,
          {
            actor: origin.kind,
            origin,
            reason: "test write",
            expectedRevision: yield* repository.currentRevision
          },
          [
            createPage(
              `id:${path}`,
              path,
              formatWikiPage({
                pageId: `id:${path}`,
                title: path,
                aliases: [],
                lifecycle: "active",
                redirectTo: null,
                metadata: {},
                body: "Made-up words."
              })
            )
          ]
        )
        const head = yield* repository.head
        if (head === null) return yield* Effect.die("Memory history has no head")
        stored.push(decodeWikiOrigin((yield* repository.inspectCommit(head)).origin))
      }
      return stored
    }).pipe(
      Effect.scoped,
      Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })),
      Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))
    )
  })

it("a Memory write's stored origin keeps the depth its run was woken at, for every run that writes", async () => {
  const origins: ReadonlyArray<WikiCommitOrigin> = [
    { kind: "agent", sessionId: "chat-1", chainDepth: 2 },
    { kind: "agent", sessionId: "chat-1" },
    { kind: "automation", automationId: "auto-owner", chainDepth: 1 },
    { kind: "upkeep", automationId: "builtin-wiki-maintenance", chainDepth: 2 }
  ]
  expect(await Effect.runPromise(storedOrigins(origins))).toEqual(origins)
})

const chatRun = (wakeDepth: number) =>
  partialService<RunQueries["Service"]>("RunQueries", {
    get: (runId): Effect.Effect<ChatRunRecord> =>
      Effect.succeed({
        runId,
        sessionId: "chat-1",
        turnId: "turn",
        status: "running",
        stopReason: null,
        startedAt: AT,
        updatedAt: AT,
        endedAt: null,
        lastSequence: null,
        metadata: {
          run_context: {
            origin: {
              kind: "chat",
              session_id: "chat-1",
              turn_id: "turn",
              ...(wakeDepth === 0 ? {} : { chain_depth: wakeDepth })
            },
            task: null
          }
        },
        errorCode: null,
        errorMessage: null,
        clientId: null,
        modelId: null,
        reasoningEffort: null
      }),
    cause: () => Effect.succeed({ automationId: undefined, wakeDepth })
  })

it("an in-chat Task step's Memory write carries the depth its step was woken at; the owner's turn carries none", async () => {
  const origin = (wakeDepth: number) =>
    writeIdentity(chatRun(wakeDepth), {
      runId: "run-1",
      sessionId: "chat-1",
      signal: new AbortController().signal,
      authority: runAuthority()
    }).then((identity) => identity.origin)
  expect([await origin(2), await origin(0)]).toEqual([
    { kind: "agent", sessionId: "chat-1", chainDepth: 2 },
    { kind: "agent", sessionId: "chat-1", chainDepth: 0 }
  ])
})

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : []
  })

it("a chat run's Memory write origin is built in one place, which reads the run's wake depth", () => {
  const src = join(import.meta.dirname, "../src")
  const builders = sourceFiles(src)
    .filter((path) => /kind: "agent",\s*sessionId/u.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(src.length + 1))
    .sort()
  expect(builders).toEqual(["tools/wiki-identity.ts", "wiki/commit.ts"])
})
