import { describe, expect, it } from "vitest"
import { answerBlockBodies, answerBlockLabel, replaceAnswerBlocks } from "@arden-hq/protocol/chat"

const block = (body: string, marker = "```") => `${marker}arden:ui\n${body}\n${marker}`

const titled =
  'root = Stack([head, s])\nhead = Header("Say \\"hi\\" twice", "sub")\ns = Slider("x", 1, 3)'

describe("answer blocks outside the renderer", () => {
  it("replaces every fence, closed or still streaming, and nothing else", () => {
    const text = [
      "Before.",
      block(titled),
      "Between.",
      "```ts\nconst a = 1\n```",
      block('root = Stack([c])\nc = Callout("x")', "~~~~"),
      "After.",
      "```arden:ui\nroot = Stack(["
    ].join("\n\n")
    expect(replaceAnswerBlocks(text, answerBlockLabel)).toBe(
      [
        "Before.",
        '[interactive block: Say "hi" twice]',
        "Between.",
        "```ts\nconst a = 1\n```",
        "[interactive block]",
        "After.",
        "[interactive block]"
      ].join("\n\n")
    )
  })

  it.each([
    {
      case: "an info string with extra words",
      text: "```arden:ui plan\nA\n```",
      bodies: ["A"],
      replaced: "<0>"
    },
    {
      case: "a closing fence longer than the opener, with prose and a block after it",
      text: "```arden:ui\nA\n`````\n\nProse.\n\n```arden:ui\nB\n```",
      bodies: ["A", "B"],
      replaced: "<0>\n\nProse.\n\n<1>"
    },
    {
      case: "a fence in a blockquote",
      text: "> ```arden:ui\n> A\n> ```",
      bodies: ["A"],
      replaced: "> <0>"
    },
    {
      case: "a fence in a list item indented four spaces",
      text: "1.  Step\n\n    ```arden:ui\n    A\n    ```",
      bodies: ["A"],
      replaced: "1.  Step\n\n    <0>"
    },
    {
      case: "an indented code block is not a fence",
      text: "    ```arden:ui\n    A",
      bodies: [],
      replaced: "    ```arden:ui\n    A"
    }
  ])("finds the blocks the renderer draws: $case", ({ text, bodies, replaced }) => {
    expect(answerBlockBodies(text)).toEqual(bodies)
    expect(replaceAnswerBlocks(text, (_body, index) => `<${index}>`)).toBe(replaced)
  })
})
