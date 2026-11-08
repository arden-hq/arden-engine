import { describe, expect, it } from "vitest"
import { checkAnswerBlock } from "../src/check.js"
import { answerBlockText, readAnswerBlock } from "../src/index.js"
import { completeStatements, guardBlock, readBlock } from "../src/read.js"
import { savedBlockState } from "../src/state.js"

const doubling = [
  "root = Stack(a22)",
  'a0 = Text("x")',
  ...Array.from({ length: 22 }, (_, index) => `a${index + 1} = [a${index}, a${index}]`)
].join("\n")

const deep = `root = Stack([${"[".repeat(6000)}${"]".repeat(6000)}])`

describe("every reader of a block goes through the guard", () => {
  it("refuses doubling references by the estimate, before the parser runs", () => {
    expect(readBlock(doubling).kind).toBe("expands")
    expect(readAnswerBlock(doubling)).toBeUndefined()
    expect(answerBlockText(doubling)).toBe("")
    expect(savedBlockState(doubling, { $x: 1 })).toEqual({ kind: "unreadable" })
    expect(checkAnswerBlock(doubling)).toEqual([
      { line: undefined, message: expect.stringContaining("expand") }
    ])
  })

  it("turns a parser stack overflow into a refusal on every reader", () => {
    expect(readBlock(deep).kind).toBe("unreadable")
    expect(answerBlockText(deep)).toBe("")
    expect(savedBlockState(deep, {})).toEqual({ kind: "unreadable" })
  })
})

describe("a block that is still being written", () => {
  const whole = (source: string) => {
    const guard = guardBlock(source)
    return guard.kind === "ok" ? completeStatements(source, guard.statements) : undefined
  }
  const head = 'root = Stack([a, b])\na = Header("Hi")\n'

  it("leaves out a half-written statement, so an image address or a tone never draws cut short", () => {
    expect(whole(`${head}b = Image("https://evil.example/ab`)).toBe(head)
    expect(whole(`${head}b = Callout("T", "x", "wa`)).toBe(head)
    expect(whole(`${head}b = Callout("T",\n`)).toBe(head)
    expect(whole(`${head}b = Image("https://a.example/x.png")`)).toBe(head)
  })

  it("holds a statement that spans lines until it is closed", () => {
    expect(whole(`${head}b = Callout("T", "line one\nline two`)).toBe(head)
    expect(whole(`${head}b = Callout("T", "line one\nline two", "info"`)).toBe(head)
    expect(whole(`${head}b = Stack([\n  a,\n  c`)).toBe(head)
    expect(whole(`${head}$n = ok ? 1\n  : 2`)).toBe(head)
    expect(whole(`${head}$n = ok ?\n`)).toBe(head)
    expect(whole(`${head}$n = ok ? 1\n  : 2\n`)).toBe(`${head}$n = ok ? 1\n  : 2\n`)
    const split = `${head}b = Callout("T", "line one\nline two", "info")\n`
    expect(whole(split)).toBe(split)
  })

  it("holds a trailing bare name, a comment line and a closing bracket inside a string", () => {
    expect(whole(`${head}b =`)).toBe(head)
    expect(whole(`${head}b = `)).toBe(head)
    expect(whole(`${head}\nb =`)).toBe(`${head}\n`)
    expect(whole(`${head}// next:\n`)).toBe(`${head}// next:\n`)
    expect(whole(`${head}b = Callout("a)", "b`)).toBe(head)
    const done = `${head}b = Callout("a)", "b\nc")\n`
    expect(whole(done)).toBe(done)
  })

  it("keeps a statement once its line has ended with everything closed", () => {
    const done = `${head}b = Image("https://a.example/x.png")\n`
    expect(whole(done)).toBe(done)
    expect(whole("")).toBe("")
  })
})

describe("lang-core token kinds read.ts relies on", () => {
  const read = (source: string) => {
    const guard = guardBlock(source)
    if (guard.kind !== "ok") throw new Error(guard.kind)
    return guard.statements
  }

  it("tells a literal $state from a computed one", () => {
    const literals = [
      "$a = 5",
      "$a = -2",
      '$a = "x"',
      "$a = true",
      "$a = null",
      '$a = [1, -2, "x", {k: true, n: null, f: false}]'
    ]
    for (const source of literals) expect(read(source)[0]?.computed, source).toBe(false)
    const computed = [
      "$a = $b",
      "$a = b",
      "$a = 1 + 2",
      "$a = -$b",
      "$a = Foo(1)",
      "$a = b.c",
      "$a = [1, $b]"
    ]
    for (const source of computed) expect(read(source)[0]?.computed, source).toBe(true)
  })

  it("collects the names and $variables a statement uses", () => {
    const [statement] = read("s = Foo(a, $v, [b, $w])")
    expect(statement?.idents).toEqual(["a", "b"])
    expect(statement?.states).toEqual(["$v", "$w"])
  })
})
