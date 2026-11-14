import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { memoryTestFiles } from "../scripts/memory-test/questions.js"

// The memory test reads the owner's private questions and a replay copy of their data. These
// guards keep it off the real data folder, keep the questions and results out of the
// repository, and keep it measuring the product's own prefetch rather than a copy of it.

const server = realpathSync(join(import.meta.dirname, ".."))
const questionFile = JSON.stringify({
  version: 1,
  approved: "2026-01-01",
  questions: [
    {
      id: "q1",
      kind: "people",
      question: "Who is the gardener?",
      space_id: null,
      expected_answer: "A neighbour.",
      expected_pages: ["people/gardener.md"]
    }
  ]
})

let root = ""

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "arden-memory-test-")))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it("refuses the owner's real data folder as the copy", () => {
  const questions = join(root, "questions.json")
  writeFileSync(questions, questionFile)
  expect(() => memoryTestFiles({ questions, copy: join(homedir(), ".arden") })).toThrow(
    /real data folder/
  )
  const accepted = memoryTestFiles({ questions, copy: join(root, "copy") })
  expect(accepted.results).toBe(root)
  expect(accepted.questions.map((question) => question.id)).toEqual(["q1"])
})

it("refuses a question file inside the repository, where results would be written", () => {
  expect(() =>
    memoryTestFiles({ questions: join(server, "package.json"), copy: join(root, "copy") })
  ).toThrow(/inside the repository/)
})

const sources = (folder: string): ReadonlyArray<string> =>
  readdirSync(join(server, folder), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(folder, name))

/** Files that call `name`, not counting the line that declares it. */
const callers = (name: string): ReadonlyArray<string> => {
  const call = new RegExp(`(?<!function )\\b${name}\\(`, "u")
  return [...sources("src"), ...sources("scripts")]
    .filter((file) => call.test(readFileSync(join(server, file), "utf8")))
    .map((file) => relative(server, join(server, file)))
}

it("measures the product's own prefetch, and no second copy of it exists", () => {
  const harness = readFileSync(join(server, "scripts", "memory-test-sent.ts"), "utf8")
  expect(harness).toMatch(
    /import \{[^}]*\bprefetchTurnMemory\b[^}]*\} from "\.\.\/src\/context\/turn-context\.js"/
  )
  expect(harness).toMatch(
    /import \{[^}]*\bopenMemoryTurn\b[^}]*\} from "\.\.\/src\/memory\/service\.js"/
  )
  // What a new chat is sent has one implementation: the chat's own context and the memory
  // test both call it, and the steps inside it are called nowhere else.
  expect(callers("prefetchTurnMemory").toSorted()).toEqual([
    "scripts/memory-test-sent.ts",
    "src/context/turn-context.ts"
  ])
  expect(callers("openMemoryTurn").toSorted()).toEqual([
    "scripts/memory-test-sent.ts",
    "src/memory/service.ts"
  ])
  expect(callers("budgetContinuityContext")).toEqual(["src/context/turn-context.ts"])
  expect(callers("spaceConversationContextSnapshot")).toEqual(["src/context/turn-context.ts"])
  expect(callers("prepareMemoryRecall")).toEqual(["src/memory/service.ts"])
})
