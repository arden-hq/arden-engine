import { cpSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ResourceVersion
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { decodeWikiOrigin, type WikiCommitOrigin } from "../src/wiki/commit.js"
import { parseWikiPage } from "../src/wiki/page.js"
import { claimKey, type OpenRetraction, putBack } from "../src/wiki/retraction.js"
import { locateReplayCopy } from "./fixtures/replay-copy.js"

const copy = locateReplayCopy()

const decoder = new TextDecoder()

const writerOf = (origin: WikiCommitOrigin): string => {
  switch (origin.kind) {
    case "user":
    case "forget":
      return "owner"
    case "agent":
      return "chat"
    case "capture":
      return "capture"
    case "automation":
      if (origin.automationId === "builtin-wiki-decomposition") return "decomposition"
      if (origin.automationId.startsWith("builtin-")) return "built-in job"
      return /^(?:task|area|desk|proj):/u.test(origin.automationId)
        ? "Space work"
        : "owner automation"
    case "upkeep":
      return "upkeep"
    case "space_page":
      return "Space page"
    case "system":
      if (origin.name.startsWith("memory.content-step.")) return "content step"
      return /migration/u.test(origin.name) ? "migration" : "system"
  }
}

const keysOf = (body: string | undefined): ReadonlySet<string> =>
  new Set((body ?? "").split("\n").flatMap((line) => claimKey(line) ?? []))

const tally = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1)

interface Replay {
  readonly planted: number
  readonly refused: number
  readonly refusedCommits: number
  readonly refusedByWriter: Readonly<Record<string, number>>
  readonly refusedByAction: Readonly<Record<string, number>>
  readonly pages: number
  readonly lines: number
  readonly firstReturns: number
  readonly returnsByWriter: Readonly<Record<string, number>>
}

it.skipIf(copy.kind === "absent")(
  "replays Memory history with removed lines planted as retractions",
  { timeout: 1_200_000 },
  async () => {
    if (copy.kind === "absent") return
    const clone = await mkdtemp(join(tmpdir(), "arden-forget-replay-"))
    try {
      cpSync(join(copy.copy.folder, "memory", "wiki"), clone, { recursive: true })
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* ManagedFileRepository
          const commits = [...(yield* repository.history({ limit: null }))].reverse()
          const bodies = new Map<string, string | undefined>()
          const bodyOf = (version: ResourceVersion | null) =>
            Effect.gen(function* () {
              if (version === null || version.state !== "active") return undefined
              const known = bodies.get(version.versionId)
              if (known !== undefined || bodies.has(version.versionId)) return known
              const text = decoder.decode(yield* repository.readVersion(version))
              const page = yield* parseWikiPage(text).pipe(Effect.option)
              const body = page._tag === "Some" ? page.value.body : text
              bodies.set(version.versionId, body)
              return body
            })
          const replay = (plants: (writer: string) => boolean) =>
            Effect.gen(function* () {
              const guarded = new Map<string, OpenRetraction>()
              const pending = new Set<string>()
              const byWriter = new Map<string, number>()
              const byAction = new Map<string, number>()
              const pages = new Set<string>()
              const lines = new Set<string>()
              let refused = 0
              const commitsRefused = new Set<string>()
              const returnsByWriter = new Map<string, number>()
              let firstReturns = 0
              for (const commit of commits) {
                const writer = writerOf(decodeWikiOrigin(commit.origin))
                for (const change of commit.changes) {
                  const before = yield* bodyOf(change.before)
                  const after = yield* bodyOf(change.after)
                  if (after !== undefined) {
                    const had = keysOf(before)
                    const added = [...keysOf(after)].filter(
                      (key) => !had.has(key) && guarded.has(key)
                    )
                    for (const key of added) {
                      if (!pending.delete(key)) continue
                      firstReturns += 1
                      tally(returnsByWriter, writer)
                    }
                    if (writer !== "owner" && putBack(guarded, before, after) !== undefined) {
                      refused += 1
                      commitsRefused.add(commit.commitId)
                      tally(byWriter, writer)
                      tally(byAction, change.action)
                      if (change.after !== null) pages.add(change.after.path)
                      for (const key of added) lines.add(key)
                    }
                  }
                  if (change.action !== "update" || !plants(writer)) continue
                  const kept = keysOf(after)
                  for (const key of keysOf(before)) {
                    if (kept.has(key)) continue
                    pending.add(key)
                    if (guarded.has(key)) continue
                    guarded.set(key, {
                      id: guarded.size + 1,
                      status: "open",
                      said: { chat: "", at: commit.timestamp },
                      claim: "",
                      removed: [{ path: change.before?.path ?? "", line: key }]
                    })
                  }
                }
              }
              return {
                planted: guarded.size,
                refused,
                refusedCommits: commitsRefused.size,
                refusedByWriter: Object.fromEntries(byWriter),
                refusedByAction: Object.fromEntries(byAction),
                pages: pages.size,
                lines: lines.size,
                firstReturns,
                returnsByWriter: Object.fromEntries(returnsByWriter)
              } satisfies Replay
            })
          return {
            commits: commits.length,
            chatsAndOwner: yield* replay((writer) => writer === "chat" || writer === "owner"),
            everyWriter: yield* replay(() => true)
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            managedFileRepositoryNodeLayer({
              workingRoot: join(clone, "pages"),
              historyRoot: join(clone, ".wiki-history")
            })
          )
        )
      )
      // Vitest swallows console output; a direct write reaches the terminal.
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
      expect(outcome.chatsAndOwner.refused).toBe(0)
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  }
)
