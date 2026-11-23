import { describe, expect, it } from "vitest"

import { splitAttachedFiles, withAttachedFiles, withFileNames } from "@arden-hq/protocol/chat"

const PDF = "/Users/me/.arden/uploads/0129dfba-3c1e-4f7a-9d1b-6a2f0c9e4b11/Документы.pdf"

describe("attached files in a message", () => {
  it("round-trips text, a file and a folder", () => {
    const content = withAttachedFiles("Check the totals.", [
      { path: PDF, directory: false },
      { path: "/Users/me/Taxes 2026", directory: true }
    ])
    expect(content).toBe(`Check the totals.\n\nAttached: ${PDF}\nAttached: /Users/me/Taxes 2026/`)
    expect(splitAttachedFiles(content)).toEqual({
      text: "Check the totals.",
      files: [
        { path: PDF, name: "Документы.pdf", directory: false },
        { path: "/Users/me/Taxes 2026", name: "Taxes 2026", directory: true }
      ]
    })
  })

  it("reads a message that is only attachments", () => {
    expect(splitAttachedFiles(`Attached: ${PDF}`)).toEqual({
      text: "",
      files: [{ path: PDF, name: "Документы.pdf", directory: false }]
    })
  })

  it("leaves text alone when the block is not strict", () => {
    for (const content of [
      'Write the note "Attached: /tmp/x" into the summary.',
      `Look at this\nAttached: ${PDF}`,
      `Attached: ${PDF}\n\nand tell me what it says`,
      "Notes\n\nAttached: relative/path.txt",
      "Notes\n\nAttached: /"
    ])
      expect(splitAttachedFiles(content)).toEqual({ text: content, files: [] })
  })

  it("reads only the trailing run of lines after the blank line", () => {
    const content = `Attached: /a.txt\n\nwords\n\nAttached: /b.txt`
    expect(splitAttachedFiles(content)).toEqual({
      text: "Attached: /a.txt\n\nwords",
      files: [{ path: "/b.txt", name: "b.txt", directory: false }]
    })
  })

  it("says the files' names instead of their path lines", () => {
    const names = withFileNames(`Attached: ${PDF}\nAttached: /Users/me/Taxes 2026/`)
    expect(names).toContain("Документы.pdf")
    expect(names).toContain("Taxes 2026")
    expect(names).not.toContain("/Users")
    const withText = withFileNames(`Check the totals.\n\nAttached: ${PDF}`)
    expect(withText).toContain("Check the totals.")
    expect(withText).toContain("Документы.pdf")
    expect(withText).not.toContain("Attached:")
    const typed = 'Write the note "Attached: /tmp/x" into the summary.'
    expect(withFileNames(typed)).toBe(typed)
  })
})
