import { describe, expect, it } from "vitest"
import { checkAnswerBlock } from "../src/check.js"
import { ANSWER_UI_MAX_BYTES } from "../src/fence.js"
import { GOLDEN_BLOCKS } from "./golden-blocks.js"

const lines = (...rows: ReadonlyArray<string>) => rows.join("\n")

describe("answer block check", () => {
  it.each(Object.entries(GOLDEN_BLOCKS))(
    "finds nothing wrong in the golden block %s",
    (_id, source) => {
      expect(checkAnswerBlock(source, { now: () => 0 })).toEqual([])
    }
  )

  it("names the line of an unknown part, a bad argument and a missing one", () => {
    const issues = checkAnswerBlock(
      lines(
        "root = Stack([a, b, c])",
        "$on = true",
        'a = Verdict("Keep it")',
        'b = Switch(42, "Hint", $on)',
        'c = Slider("Runs")'
      )
    )
    expect(issues.map((issue) => issue.line)).toEqual([3, 4, 5, 5])
  })

  it("rejects state set from an expression, at its line", () => {
    expect(
      checkAnswerBlock(
        lines(
          "root = Stack([s])",
          "$base = 2",
          "$double = $base * 2",
          's = Slider("Base", 0, 10, 1, $base)'
        )
      )
    ).toEqual([{ line: 3, message: expect.stringContaining("`$double`") }])
  })

  it("rejects a control that binds state declared below it", () => {
    expect(
      checkAnswerBlock(
        lines("root = Stack([s])", 's = Slider("Base", 0, 10, 1, $base)', "$base = 2")
      )
    ).toEqual([{ line: 2, message: expect.stringContaining("`$base`") }])
  })

  it("refuses a body over the size cap without parsing it", () => {
    const body = `root = Stack([h])\nh = Header("${"a".repeat(ANSWER_UI_MAX_BYTES)}")`
    expect(checkAnswerBlock(body)).toEqual([{ line: undefined, message: expect.any(String) }])
  })

  it("refuses a Mutation and a Query of any tool but tool_result, at their lines", () => {
    const issues = checkAnswerBlock(
      lines(
        "root = Stack([m])",
        'save = Mutation("calendar_create_event", {title: "x"})',
        'found = Query("web_search", {query: "x"}, [])',
        'm = Metric("Found", 1)'
      )
    )
    expect(issues.map((issue) => issue.line)).toEqual([2, 3])
  })

  it("checks a tool_result Query's shape, and its call and path when the chat's results are given", () => {
    const block = (args: string, refresh = "") =>
      lines(
        "root = Stack([m])",
        `price = Query("tool_result", ${args}, null${refresh})`,
        'm = Metric("Price", price, "usd")'
      )
    const results = new Map([["call_1", '{"items":[{"price":12}]}']])
    const toolResult = (id: string) => results.get(id)
    const ok = block('{call: "call_1", path: "items.0.price"}')
    expect(checkAnswerBlock(ok)).toEqual([])
    expect(checkAnswerBlock(ok, { toolResult })).toEqual([])
    expect(checkAnswerBlock(block("{call: $id}"))).toHaveLength(1)
    expect(checkAnswerBlock(block('{call: "call_1", url: "x"}'))).toHaveLength(1)
    expect(checkAnswerBlock(block('{call: "call_1"}', ", 30"))).toHaveLength(1)
    expect(checkAnswerBlock(block('{call: "call_9", path: "items"}'), { toolResult })).toEqual([
      { line: 2, message: expect.stringContaining("call_9") }
    ])
    expect(
      checkAnswerBlock(block('{call: "call_1", path: "items.3.price"}'), { toolResult })
    ).toEqual([{ line: 2, message: expect.stringContaining("items.3.price") }])
  })

  it("names a formula that does not read and a variable missing from its vars", () => {
    const issues = checkAnswerBlock(
      lines(
        "root = Stack([growth, totals])",
        "$years = 20",
        'growth = Plot({x: {from: 0, to: $years}, series: [{name: "a", fn: "m * (1 + r)^x", vars: {m: $years}}, {name: "b", fn: "2 ** x"}]})',
        'totals = Summary([Formula("Final", "sin(n)", {n: $years}), Formula("Ok", "n * 2", {n: $years})])'
      ),
      { now: () => 0 }
    )
    expect(issues).toEqual([
      { line: 3, message: expect.stringMatching(/"a".*`r` is not in vars/) },
      { line: 3, message: expect.stringMatching(/"b".*\^/) },
      { line: 4, message: expect.stringMatching(/"Final".*`sin`/) }
    ])
  })

  it("turns a parser stack overflow into an issue instead of a throw", () => {
    const depth = 6000
    const body = `root = Stack([${"[".repeat(depth)}${"]".repeat(depth)}])`
    expect(checkAnswerBlock(body)).toEqual([{ line: undefined, message: expect.any(String) }])
  })
})
