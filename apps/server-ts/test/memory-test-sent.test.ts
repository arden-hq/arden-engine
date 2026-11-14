import { describe, expect, it } from "vitest"
import { parseQuestions, type Question } from "../scripts/memory-test/questions.js"
import {
  countByKind,
  deliveryOf,
  renderCountTable,
  scoreSent,
  type PrefetchedMemory
} from "../scripts/memory-test/sent.js"

// Made-up pages and questions; nothing here comes from anyone's Memory.

const block = (path: string, body: string) => `### ${path}\nPage: ${path}\n\n${body}`

/** A page as its renderer sent it: whole, or (`partial`) cut short by the renderer itself. */
const rendered = (path: string, body: string, partial = false) => ({
  path,
  text: block(path, partial ? `${body}\n\n[Partial page]` : body),
  whole: !partial
})

const prefetched = (input: {
  readonly core?: ReadonlyArray<string>
  readonly recalled?: ReadonlyArray<string>
  /** Recalled pages the renderer sent in part. */
  readonly recalledInPart?: ReadonlyArray<string>
  readonly listed?: ReadonlyArray<string>
  readonly keptRecall?: (text: string) => string
  readonly space?: {
    readonly path: string
    readonly whole: boolean
    readonly kept?: (text: string) => string
  }
}): PrefetchedMemory => {
  const corePages = (input.core ?? []).map((path) => rendered(path, "core fact"))
  const recalledPages = [
    ...(input.recalled ?? []).map((path) =>
      rendered(path, "recalled fact, first line\nsecond line")
    ),
    ...(input.recalledInPart ?? []).map((path) => rendered(path, "recalled fact", true))
  ]
  const core = corePages.map((page) => page.text).join("\n\n")
  const recalled = recalledPages.map((page) => page.text).join("\n\n")
  const listed = (input.listed ?? []).map((path) => `- ${path}: a folder`).join("\n")
  const text = [recalled, listed].filter((part) => part !== "").join("\n\n")
  const kept = (input.keptRecall ?? ((all) => all))(text)
  const spacePage =
    input.space === undefined
      ? undefined
      : {
          path: input.space.path,
          text: `Space memory page (${input.space.path}):\nplan, first line\nplan, second line`,
          whole: input.space.whole
        }
  const spaceText =
    spacePage === undefined
      ? undefined
      : `## Current Space\n\n${spacePage.text}\n\nUse the Space tools.`
  const keptSpace =
    spaceText === undefined ? undefined : (input.space?.kept ?? ((all) => all))(spaceText)
  return {
    spaceRender: spaceText === undefined ? undefined : { page: spacePage },
    recall: { core: core === "" ? null : core, pages: [...corePages, ...recalledPages] },
    continuity: {
      sources: [
        ...(keptSpace === undefined || keptSpace === ""
          ? []
          : [{ kind: "session", content: keptSpace }]),
        ...(kept === "" ? [] : [{ kind: "recall", content: kept }])
      ],
      telemetry: { outputBytes: kept.length, truncatedBytes: text.length - kept.length }
    }
  }
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
    const result = scoreSent(
      question({ kind: "multi_hop" }),
      deliveryOf(
        prefetched({
          core: ["me.md"],
          recalled: ["people/gardener.md"],
          space: { path: "projects/garden.md", whole: true }
        })
      )
    )
    expect(result.sent).toBe(true)
    expect(result.pages).toEqual([
      { path: "me.md", via: "core", whole: true },
      { path: "people/gardener.md", via: "recall", whole: true },
      { path: "projects/garden.md", via: "space", whole: true }
    ])
  })

  it("is not sent when one expected page is missing, and names it", () => {
    const result = scoreSent(
      question({ kind: "where_it_stands" }),
      deliveryOf(prefetched({ recalled: ["projects/garden.md", "projects/kitchen.md"] }))
    )
    expect(result).toMatchObject({ sent: false, missing: ["people/gardener.md"], cut: [] })
  })

  it("does not count a page named only in a collection line", () => {
    const result = scoreSent(
      question({ kind: "people", expected_pages: ["people/gardener.md"] }),
      deliveryOf(prefetched({ listed: ["people/gardener.md"] }))
    )
    expect(result).toMatchObject({ sent: false, missing: ["people/gardener.md"] })
  })

  it("names an expected page the continuity budget cut", () => {
    const delivery = deliveryOf(
      prefetched({
        recalled: ["projects/kitchen.md", "projects/garden.md"],
        keptRecall: (text) => text.slice(0, text.indexOf("### projects/garden.md"))
      })
    )
    const result = scoreSent(
      question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
      delivery
    )
    expect(result).toMatchObject({
      sent: false,
      missing: ["projects/garden.md"],
      cut: ["projects/garden.md"]
    })
    expect(delivery.bytes.cut).toBeGreaterThan(0)
  })

  it("names a recalled page the budget cut mid-body as cut, not sent", () => {
    const delivery = deliveryOf(
      prefetched({
        recalled: ["projects/kitchen.md", "projects/garden.md"],
        keptRecall: (text) =>
          text.slice(0, text.indexOf("second line", text.indexOf("Page: projects/garden.md")))
      })
    )
    const result = scoreSent(
      question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
      delivery
    )
    expect(result).toMatchObject({
      sent: false,
      missing: ["projects/garden.md"],
      cut: ["projects/garden.md"],
      pages: [{ path: "projects/kitchen.md", via: "recall", whole: true }]
    })
  })

  it("counts a Space page the budget cut mid-page as cut, not sent", () => {
    const result = scoreSent(
      question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
      deliveryOf(
        prefetched({
          space: {
            path: "projects/garden.md",
            whole: true,
            kept: (text) => text.slice(0, text.indexOf("second line"))
          }
        })
      )
    )
    expect(result).toMatchObject({ sent: false, cut: ["projects/garden.md"] })
  })

  it("counts a Space page as sent when the budget cut only the text after it", () => {
    const result = scoreSent(
      question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
      deliveryOf(
        prefetched({
          space: {
            path: "projects/garden.md",
            whole: true,
            kept: (text) => text.slice(0, text.indexOf("Use the Space tools"))
          }
        })
      )
    )
    expect(result).toMatchObject({ sent: true, cut: [], budgetCut: [] })
  })

  it("says when the renderer sent an expected page in part, for recall and Space alike", () => {
    const results = [
      scoreSent(
        question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
        deliveryOf(prefetched({ recalledInPart: ["projects/garden.md"] }))
      ),
      scoreSent(
        question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
        deliveryOf(prefetched({ space: { path: "projects/garden.md", whole: false } }))
      ),
      scoreSent(
        question({ kind: "where_it_stands", expected_pages: ["projects/garden.md"] }),
        deliveryOf(prefetched({ recalled: ["projects/garden.md"] }))
      )
    ]
    expect(results.map((result) => [result.sent, result.inPart])).toEqual([
      [true, ["projects/garden.md"]],
      [true, ["projects/garden.md"]],
      [true, []]
    ])
    expect(results[0]?.pages).toEqual([{ path: "projects/garden.md", via: "recall", whole: false }])
    expect(results[1]?.pages).toEqual([{ path: "projects/garden.md", via: "space", whole: false }])
    expect(countByKind(results).find((row) => row.kind === "total")).toEqual({
      kind: "total",
      questions: 3,
      sent: 3,
      inPart: 2,
      cut: 0
    })
    expect(renderCountTable(results).split("\n")[0]).toContain("sent in part")
  })

  it("a question with no answer is sent when nothing misleading reached the chat", () => {
    const delivery = deliveryOf(prefetched({ core: ["me.md"], recalled: ["projects/garden.md"] }))
    expect(scoreSent(question({ kind: "no_answer" }), delivery)).toMatchObject({
      sent: true,
      misleading: []
    })
  })

  it("a question with no answer is not sent when a misleading pattern reached the chat", () => {
    const misleadingPage = prefetched({ recalled: ["notes/shoes.md"] })
    const delivery = deliveryOf({
      ...misleadingPage,
      continuity: {
        ...misleadingPage.continuity,
        sources: [{ kind: "recall", content: "Shoe size 44 (guessed)." }]
      }
    })
    expect(scoreSent(question({ kind: "no_answer" }), delivery)).toMatchObject({
      sent: false,
      misleading: ["shoe size"]
    })
  })

  it("counts every kind, in order, with a total, and prints counts only", () => {
    const delivery = deliveryOf(prefetched({ core: ["me.md"] }))
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
