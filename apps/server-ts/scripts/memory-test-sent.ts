// The "sent" half of the memory test, with no model: for each question in the owner's private
// question file, open a new chat on the replay copy with the question as its first message (in
// the question's Space, if it names one) and run the product's own prefetch, the code a real
// new chat runs, which records on the copy what the run was sent. The score reads that record:
// which pages were sent, the bytes, what the budget cut, and whether every expected page was
// sent. Writes the results beside the question file, never in the
// repository, and prints counts by kind only.
//
// Run it with `just memory-test-sent <question file> <replay folder>`. It runs under vitest,
// which resolves the engine's TypeScript sources, and opens the copy only through
// test/fixtures/replay-copy.ts: no server, no scheduler, no model, and `fetch` refuses.
//
// Semantic recall is off: matching by meaning embeds the question with the local embedding
// model, which is a model call. Recall here is by words, Core Memory and the Space page.

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, References } from "effect"
import { it } from "vitest"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { openMemoryTurn } from "../src/memory/service.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { SummaryStore } from "../src/persistence/summaries/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { Wiki, wikiLayer } from "../src/wiki/service.js"
import { runOnReplayCopy } from "../test/fixtures/replay-copy.js"
import { memoryTestFiles } from "./memory-test/questions.js"
import { deliveryOf, renderCountTable, scoreSent, type SentResult } from "./memory-test/sent.js"

const SEMANTIC_RECALL = "off: matching by meaning needs the local embedding model"

const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? ""
  if (value === "") throw new Error(`${name} is not set; run \`just memory-test-sent\``)
  return value
}

it("scores whether a new chat is sent the pages that answer each question", async () => {
  const files = memoryTestFiles({
    questions: required("ARDEN_MEMORY_TEST_QUESTIONS"),
    copy: required("ARDEN_REPLAY_COPY")
  })
  if (!existsSync(files.copy.database))
    throw new Error(`No replay copy at ${files.copy.database}; run \`just replay-copy\` first`)
  const wiki = wikiLayer({
    workingRoot: join(files.copy.wiki, "pages"),
    historyRoot: join(files.copy.wiki, ".wiki-history")
  }).pipe(Layer.provide(automationWikiChangeSinkLayer))

  const ranAt = new Date().toISOString()
  const stamp = ranAt.replaceAll(/[:.]/gu, "-")
  const results = await runOnReplayCopy(
    files.copy,
    Effect.gen(function* () {
      const services = {
        spaces: yield* SpaceStore,
        summaries: yield* SummaryStore,
        work: yield* WorkStore,
        chat: yield* ChatWriteStore
      }
      const runs = yield* RunQueries
      const turnServices = {
        wiki: yield* Wiki,
        sessions: yield* SessionQueries,
        spaces: services.spaces,
        embeddings: { search: () => Effect.succeed([]) }
      }
      const scored: Array<SentResult> = []
      for (const question of files.questions) {
        // A chat that does not exist yet: the question is its first message. Each harness run
        // gets its own run ids, so the record read back is this run's alone.
        const sessionId = `memory-test-chat-${question.id}`
        const runId = `memory-test-run-${stamp}-${question.id}`
        const memory = yield* openMemoryTurn(turnServices)
        if (memory === undefined)
          return yield* Effect.die(new Error("The Memory snapshot failed on the copy"))
        const { space, memoryContext } = yield* prefetchTurnMemory(services, {
          sessionId,
          runId,
          spaceId: question.space_id ?? undefined,
          query: question.question,
          memory,
          measure: (_part, effect) => effect
        })
        // A setup fault stops the batch: it is not a score.
        if (memoryContext.record.query === null)
          return yield* Effect.die(new Error(`Memory recall failed on ${question.id}`))
        if (question.space_id !== null && space === undefined)
          return yield* Effect.die(new Error(`The Space of ${question.id} is not on the copy`))
        const composition = (yield* runs.memoryContext(runId)).at(-1)
        if (composition === undefined)
          return yield* Effect.die(new Error(`No record of what ${question.id} was sent`))
        const paths = new Map<string, string>()
        for (const source of composition.sources)
          if (source.page_id !== null && !paths.has(source.page_id))
            paths.set(source.page_id, (yield* memory.readContent(source.page_id)).path)
        const text = [...memoryContext.core, ...memoryContext.space, ...memoryContext.recall]
          .map((section) => section.text)
          .join("\n\n")
        scored.push(scoreSent(question, deliveryOf({ composition, paths, text })))
      }
      return scored
    }).pipe(Effect.provide(wiki), Effect.provideService(References.MinimumLogLevel, "Warn"))
  )

  const resultFile = join(files.results, `results-sent-${stamp}.json`)
  writeFileSync(
    resultFile,
    `${JSON.stringify({ ranAt, copy: files.copy.folder, semanticRecall: SEMANTIC_RECALL, results }, null, 2)}\n`,
    { mode: 0o600 }
  )
  // Vitest swallows console output here; a direct write reaches the terminal.
  process.stdout.write(
    [
      "",
      `Sent: every expected page in what a new chat is sent. Semantic recall ${SEMANTIC_RECALL}.`,
      renderCountTable(results),
      `Results: ${resultFile}`,
      ""
    ].join("\n")
  )
}, 3_600_000)
