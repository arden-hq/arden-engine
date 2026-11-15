import type { RunMemoryContext, RunMemorySource } from "@arden-hq/protocol/runs"
import { describe, expect, it } from "vitest"
import { parseQuestions, type Question } from "../scripts/memory-test/questions.js"
import {
  countByKind,
  deliveryOf,
  regressionsFrom,
  renderCountTable,
  scoreSent
} from "../scripts/memory-test/sent.js"

// Made-up pages and questions; nothing here comes from anyone's Memory.

type Placement = Pick<RunMemorySource, "outcome" | "reason">

const WHOLE: Placement = { outcome: "whole", reason: null }
/** Cut short at a boundary, with a notice, to fit the recall's allowance. */
const RENDERED_IN_PART: Placement = { outcome: "cut", reason: "recall_allowance" }
const PASSAGE: Placement = { outcome: "passage", reason: null }
const NO_ROOM: Placement = { outcome: "dropped", reason: "recall_allowance" }

const pageId = (path: string) => `page-${path.replaceAll(/[/.]/gu, "-")}`

/** One composition of a run's record, the page paths it names, and the text it was sent. */
const recorded = (input: {
  readonly core?: ReadonlyArray<string>
  readonly recalled?: ReadonlyArray<readonly [string, Placement] | string>
  readonly indexed?: number
  readonly space?: { readonly path: string; readonly outcome: "whole" | "cut" | "dropped" }
  readonly text?: string
}) => {
  const page = (
    kind: "core" | "recalled",
    path: string,
    placement: Placement
  ): RunMemorySource => ({
    kind,
    page_id: pageId(path),
    version: "v1",
    bytes: placement.outcome === "dropped" ? 0 : 40,
    ...placement
  })
  const sources: Array<RunMemorySource> = [
    ...(input.space === undefined
      ? []
      : [
          {
            kind: "space" as const,
            space_id: "space-garden",
            page_id: pageId(input.space.path),
            version: "v1",
            bytes: 300,
            outcome: input.space.outcome,
            reason: input.space.outcome === "whole" ? null : ("space_page_allowance" as const)
          }
        ]),
    ...(input.core ?? []).map((path) => page("core", path, WHOLE)),
    ...(input.recalled ?? []).map((entry) =>
      typeof entry === "string" ? page("recalled", entry, WHOLE) : page("recalled", ...entry)
    ),
    ...(input.indexed === undefined
      ? []
      : [
          {
            kind: "index" as const,
            root: "",
            listed: input.indexed,
            folded: [],
            bytes: 500,
            ...WHOLE
          }
        ])
  ]
  const composition: RunMemoryContext = {
    reader: "owner",
    revision: "rev-1",
    query: "a question",
    sources
  }
  const paths = new Map(
    [
      ...(input.core ?? []),
      ...(input.recalled ?? []).map((entry) => (typeof entry === "string" ? entry : entry[0])),
      ...(input.space === undefined ? [] : [input.space.path])
    ].map((path) => [pageId(path), path] as const)
  )
  return deliveryOf({ composition, paths, text: input.text ?? "Page: projects/garden.md" })
}

const defaults = (kind: Question["kind"]): Record<string, unknown> => {
  switch (kind) {
    case "no_answer":
      return {
        question: "What is my shoe size?",
        space_id: null,
        expected_answer: "Says it does not know.",
        expected_pages: [],
        misleading: ["shoe size"]
      }
    case "standing_rule":
      return {
        question: "Tidy my desk.",
        space_id: null,
        expected_behavior: "Asks first.",
        expected_pages: ["me.md"]
      }
    case "personal_fact":
    case "where_it_stands":
    case "did_before":
    case "people":
    case "changed_fact":
    case "multi_hop":
    case "adversarial":
      return {
        question: "Where does the garden plan stand?",
        space_id: "space-garden",
        expected_answer: "Seeds ordered on 2 March 2026.",
        expected_pages: ["projects/garden.md", "people/gardener.md"]
      }
  }
}

/** A made-up question, decoded the way the question file is. */
const question = (overrides: Partial<Question> & Pick<Question, "kind">): Question => {
  const [decoded] = parseQuestions(
    JSON.stringify({
      version: 1,
      approved: "2026-01-01",
      questions: [{ id: "q-test", ...defaults(overrides.kind), ...overrides }]
    })
  )
  if (decoded === undefined) throw new Error("The fixture question did not decode")
  return decoded
}

describe("sent score", () => {
  it("is sent when every expected page reached the chat, by any route", () => {
    const delivery = recorded({
      core: ["me.md"],
      recalled: ["people/gardener.md"],
      space: { path: "projects/garden.md", outcome: "whole" }
    })
    const result = scoreSent(question({ kind: "multi_hop" }), delivery)
    expect(result.sent).toBe(true)
    expect(result.pages).toEqual([
      { path: "projects/garden.md", via: "space", whole: true },
      { path: "me.md", via: "core", whole: true },
      { path: "people/gardener.md", via: "recall", whole: true }
    ])
    expect(delivery.bytes).toEqual({ core: 40, recall: 40, space: 300, index: 0 })
  })

  it("is not sent when one expected page is missing, and names it", () => {
    const result = scoreSent(
      question({ kind: "where_it_stands" }),
      recorded({ recalled: ["projects/garden.md", "projects/kitchen.md"] })
    )
    expect(result).toMatchObject({ sent: false, missing: ["people/gardener.md"], cut: [] })
  })

  it("does not count a page named only in the index", () => {
    const delivery = recorded({ indexed: 12 })
    const result = scoreSent(
      question({ kind: "people", expected_pages: ["people/gardener.md"] }),
      delivery
    )
    expect(result).toMatchObject({ sent: false, missing: ["people/gardener.md"] })
    expect(delivery.bytes.index).toBe(500)
  })

  it("names an expected page left out for room", () => {
    const result = scoreSent(
      question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
      recorded({ recalled: ["projects/kitchen.md", ["projects/garden.md", NO_ROOM]] })
    )
    expect(result).toMatchObject({
      sent: false,
      missing: ["projects/garden.md"],
      cut: ["projects/garden.md"],
      pages: [{ path: "projects/kitchen.md", via: "recall", whole: true }]
    })
  })

  it("counts a Space page its allowance dropped as not sent, left out for room", () => {
    const result = scoreSent(
      question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
      recorded({ space: { path: "projects/garden.md", outcome: "dropped" } })
    )
    expect(result).toMatchObject({
      sent: false,
      missing: ["projects/garden.md"],
      cut: ["projects/garden.md"]
    })
  })

  it("says when an expected page reached the chat in part, for recall and Space alike", () => {
    const ask = () => question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] })
    const results = [
      scoreSent(ask(), recorded({ recalled: [["projects/garden.md", RENDERED_IN_PART]] })),
      scoreSent(ask(), recorded({ space: { path: "projects/garden.md", outcome: "cut" } })),
      scoreSent(ask(), recorded({ recalled: [["projects/garden.md", PASSAGE]] })),
      scoreSent(ask(), recorded({ recalled: ["projects/garden.md"] }))
    ]
    expect(results.map((result) => [result.sent, result.inPart])).toEqual([
      [true, ["projects/garden.md"]],
      [true, ["projects/garden.md"]],
      [true, ["projects/garden.md"]],
      [true, []]
    ])
    expect(results[0]?.pages).toEqual([{ path: "projects/garden.md", via: "recall", whole: false }])
    expect(results[1]?.pages).toEqual([{ path: "projects/garden.md", via: "space", whole: false }])
    expect(countByKind(results).find((row) => row.kind === "total")).toEqual({
      kind: "total",
      questions: 4,
      sent: 4,
      inPart: 3,
      cut: 0
    })
    expect(renderCountTable(results).split("\n")[0]).toContain("sent in part")
  })

  it("a question with no answer is sent when nothing misleading reached the chat", () => {
    const delivery = recorded({ core: ["me.md"], recalled: ["projects/garden.md"] })
    expect(scoreSent(question({ kind: "no_answer" }), delivery)).toMatchObject({
      sent: true,
      misleading: []
    })
  })

  it("a question with no answer is not sent when a misleading pattern reached the chat", () => {
    const delivery = recorded({ recalled: ["notes/shoes.md"], text: "Shoe size 44 (guessed)." })
    expect(scoreSent(question({ kind: "no_answer" }), delivery)).toMatchObject({
      sent: false,
      misleading: ["shoe size"]
    })
  })

  it("refuses a recorded page the copy has no path for", () => {
    expect(() =>
      deliveryOf({
        composition: {
          reader: "owner",
          revision: "rev-1",
          query: "a question",
          sources: [{ kind: "core", page_id: "page-x", version: "v1", ...WHOLE, bytes: 4 }]
        },
        paths: new Map(),
        text: ""
      })
    ).toThrow(/no path/)
  })

  it("counts every kind, in order, with a total, and prints counts only", () => {
    const delivery = recorded({ core: ["me.md"] })
    const results = [
      scoreSent(question({ kind: "standing_rule" }), delivery),
      scoreSent(question({ kind: "people", expected_pages: ["people/gardener.md"] }), delivery)
    ]
    const rows = countByKind(results)
    expect(rows.map((row) => row.kind)).toEqual([
      "personal_fact",
      "where_it_stands",
      "did_before",
      "people",
      "standing_rule",
      "changed_fact",
      "no_answer",
      "multi_hop",
      "adversarial",
      "total"
    ])
    expect(rows.find((row) => row.kind === "total")).toEqual({
      kind: "total",
      questions: 2,
      sent: 1,
      inPart: 0,
      cut: 0
    })
    const table = renderCountTable(results)
    expect(table).not.toContain("Tidy my desk")
    expect(table).not.toContain("gardener")
  })
})

describe("against a baseline", () => {
  const GARDEN = "projects/garden.md"
  const KITCHEN = "projects/kitchen.md"
  const ask = () => question({ kind: "where_it_stands", expected_pages: [GARDEN, KITCHEN] })
  const score = (
    garden: Placement | "missing",
    kitchen: Placement | "missing"
  ): ReturnType<typeof scoreSent> =>
    scoreSent(
      ask(),
      recorded({
        recalled: [
          ...(garden === "missing" ? [] : [[GARDEN, garden] as const]),
          ...(kitchen === "missing" ? [] : [[KITCHEN, kitchen] as const])
        ]
      })
    )

  it("fails each expected page sent less fully: whole to in part, in part or whole to not sent", () => {
    expect(regressionsFrom([score(WHOLE, WHOLE)], [score(RENDERED_IN_PART, WHOLE)])).toEqual([
      { id: "q-test", path: GARDEN, was: "sent whole", now: "sent in part" }
    ])
    expect(regressionsFrom([score(RENDERED_IN_PART, WHOLE)], [score("missing", WHOLE)])).toEqual([
      { id: "q-test", path: GARDEN, was: "sent in part", now: "not sent" }
    ])
  })

  it("fails a page that gets worse while its question stays at the same level", () => {
    expect(regressionsFrom([score("missing", WHOLE)], [score("missing", "missing")])).toEqual([
      { id: "q-test", path: KITCHEN, was: "sent whole", now: "not sent" }
    ])
    expect(
      regressionsFrom([score(RENDERED_IN_PART, WHOLE)], [score(RENDERED_IN_PART, PASSAGE)])
    ).toEqual([{ id: "q-test", path: KITCHEN, was: "sent whole", now: "sent in part" }])
  })

  it("passes pages sent as fully or more, and a question the baseline did not have", () => {
    expect(
      regressionsFrom([score("missing", "missing")], [score(RENDERED_IN_PART, WHOLE)])
    ).toEqual([])
    expect(regressionsFrom([score(WHOLE, WHOLE)], [score(WHOLE, WHOLE)])).toEqual([])
    expect(regressionsFrom([], [score("missing", "missing")])).toEqual([])
  })
})

describe("question file", () => {
  it("refuses a repeated id and an expected page on a question with no answer", () => {
    const one = {
      id: "q1",
      kind: "people",
      question: "Who is the gardener?",
      space_id: null,
      expected_answer: "A neighbour.",
      expected_pages: ["people/gardener.md"]
    }
    const file = (questions: ReadonlyArray<unknown>) =>
      JSON.stringify({ version: 1, approved: "2026-01-01", questions })
    expect(() => parseQuestions(file([one, one]))).toThrow(/appears twice/)
    expect(() =>
      parseQuestions(
        file([
          {
            ...one,
            kind: "no_answer",
            misleading: ["gardener"]
          }
        ])
      )
    ).toThrow()
  })
})
