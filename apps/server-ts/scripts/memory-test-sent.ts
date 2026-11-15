import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Clock, Effect, Layer, References, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
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
import {
  deliveryOf,
  regressionsFrom,
  renderCountTable,
  scoreSent,
  type SentResult
} from "./memory-test/sent.js"

const SEMANTIC_RECALL = "off: matching by meaning needs the local embedding model"

class SetupFault extends Schema.TaggedError<SetupFault>()("SetupFault", {
  message: Schema.String
}) {}

const setupFault = (message: string) => Effect.fail(new SetupFault({ message }))

const afterNewestStoredMessage = Effect.fn("MemoryTest.afterNewestStoredMessage")(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly newest: string | null }>`
    SELECT MAX(created_at) AS newest FROM session_messages`
  const newest = row?.newest ?? null
  if (newest === null) return yield* setupFault("The copy holds no messages")
  return Date.parse(newest) + 1
})

const pinnedClock = (clock: Clock.Clock, at: number): Clock.Clock => ({
  ...clock,
  currentTimeMillisUnsafe: () => at,
  currentTimeMillis: Effect.succeed(at),
  currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n)
})

const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? ""
  if (value === "") throw new Error(`${name} is not set; run \`just memory-test-sent\``)
  return value
}

const BaselineFile = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        missing: Schema.Array(Schema.String),
        inPart: Schema.Array(Schema.String)
      })
    )
  })
)

const baselineOf = (flags: string): string | undefined => {
  const words = flags.split(/\s+/u).filter(Boolean)
  const at = words.indexOf("--baseline")
  if (at < 0) {
    if (words.length > 0) throw new Error(`Unknown flags: ${flags}`)
    return undefined
  }
  const file = words[at + 1]
  if (file === undefined || words.length !== 2)
    throw new Error("Use --baseline <results file>, and nothing else")
  return file
}

it("scores whether a new chat is sent the pages that answer each question", async () => {
  const baselineFile = baselineOf(process.env.ARDEN_MEMORY_TEST_FLAGS ?? "")
  const baseline =
    baselineFile === undefined
      ? undefined
      : Schema.decodeUnknownSync(BaselineFile)(readFileSync(baselineFile, "utf8")).results
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
  const scoreAll = Effect.gen(function* () {
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
      const sessionId = `memory-test-chat-${question.id}`
      const runId = `memory-test-run-${stamp}-${question.id}`
      const memory = yield* openMemoryTurn(turnServices)
      if (memory === undefined) return yield* setupFault("The Memory snapshot failed on the copy")
      const { space, memoryContext } = yield* prefetchTurnMemory(services, {
        sessionId,
        runId,
        reader: "owner",
        spaceId: question.space_id ?? undefined,
        query: question.question,
        memory,
        measure: (_part, effect) => effect
      })
      if (memoryContext.record.query === null)
        return yield* setupFault(`Memory recall failed on ${question.id}`)
      if (question.space_id !== null && space === undefined)
        return yield* setupFault(`The Space of ${question.id} is not on the copy`)
      const composition = (yield* runs.memoryContext(runId)).at(-1)
      if (composition === undefined)
        return yield* setupFault(`No record of what ${question.id} was sent`)
      const paths = new Map<string, string>()
      for (const source of composition.sources)
        if (source.kind !== "index" && source.page_id !== null && !paths.has(source.page_id))
          paths.set(source.page_id, (yield* memory.readContent(source.page_id)).path)
      const text = [...memoryContext.core, ...memoryContext.space, ...memoryContext.recall]
        .map((section) => section.text)
        .join("\n\n")
      scored.push(scoreSent(question, deliveryOf({ composition, paths, text })))
    }
    return scored
  })

  const { asked, results } = await runOnReplayCopy(
    files.copy,
    Effect.gen(function* () {
      const at = yield* afterNewestStoredMessage()
      const scored = yield* scoreAll.pipe(
        Effect.provideService(Clock.Clock, pinnedClock(yield* Clock.Clock, at))
      )
      return { asked: new Date(at).toISOString(), results: scored }
    }).pipe(Effect.provide(wiki), Effect.provideService(References.MinimumLogLevel, "Warn"))
  )

  const resultFile = join(files.results, `results-sent-${stamp}.json`)
  writeFileSync(
    resultFile,
    `${JSON.stringify({ ranAt, askedAt: asked, copy: files.copy.folder, semanticRecall: SEMANTIC_RECALL, results }, null, 2)}\n`,
    { mode: 0o600 }
  )
  // Vitest swallows console output here; a direct write reaches the terminal.
  const regressions = baseline === undefined ? [] : regressionsFrom(baseline, results)
  process.stdout.write(
    [
      "",
      `Sent: every expected page in what a new chat is sent at ${asked}. Semantic recall ${SEMANTIC_RECALL}.`,
      renderCountTable(results),
      `Results: ${resultFile}`,
      ...(baselineFile === undefined
        ? []
        : [
            `Against ${baselineFile}: ${regressions.length === 0 ? "no expected page is sent less fully." : `${regressions.length} expected pages sent less fully:`}`,
            ...regressions.map(
              (regression) =>
                `  ${regression.id} ${regression.path}: ${regression.was} to ${regression.now}`
            )
          ]),
      ""
    ].join("\n")
  )
  if (regressions.length > 0)
    throw new Error(`${regressions.length} expected pages are sent less fully than the baseline`)
}, 3_600_000)
