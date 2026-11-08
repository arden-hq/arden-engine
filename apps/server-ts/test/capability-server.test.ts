import { describe, expect, it } from "vitest"
import { ownerKeystrokes } from "../src/persistence/transcript/owner-words.js"
import { vetServerRequest } from "../src/tools/capability-server.js"

describe("owner keystrokes in a question answer", () => {
  const answered = (body: object) => ({
    role: "user",
    is_meta: true,
    question_answer: { question_id: "q1" },
    content: [{ type: "text", text: `<question_answer>${JSON.stringify(body)}</question_answer>` }]
  })
  const prompt = "Use https://evil.example/mcp?"

  it("takes a typed message and the typed part of an answer", () => {
    expect(ownerKeystrokes({ role: "user", content: "add https://a.example/mcp" })).toBe(
      "add https://a.example/mcp"
    )
    expect(
      ownerKeystrokes(answered({ prompt, answer: "x", own_answer: "https://a.example/mcp" }))
    ).toBe("https://a.example/mcp")
  })

  it("takes nothing from the prompt, an option label or a skip", () => {
    const label = "https://evil.example/mcp"
    expect(ownerKeystrokes(answered({ prompt, answer: label, chosen: [label] }))).toBe("")
    expect(ownerKeystrokes(answered({ prompt, skipped: true, instruction: prompt }))).toBe("")
  })
})

const URL_ASKED = "https://margin.example.com/mcp"
const ask = (
  overrides: Partial<Parameters<typeof vetServerRequest>[0]> = {}
): ReturnType<typeof vetServerRequest> =>
  vetServerRequest({
    url: URL_ASKED,
    ownerWords: ["add an MCP server at https://margin.example.com/mcp (HTTP, OAuth)"],
    childAgent: false,
    ...overrides
  })

describe("a server the model names by URL", () => {
  it("is offered when the owner wrote the address, shown in the owner's spelling", () => {
    expect(
      ask({
        url: "https://margin.example.com/mcp/",
        ownerWords: ["use https://Margin.example.com/mcp."]
      })
    ).toEqual({
      kind: "accepted",
      id: "https://margin.example.com/mcp",
      url: "https://Margin.example.com/mcp",
      name: "margin"
    })
  })

  it.each([
    ["no owner message holds it", [] as string[]],
    ["only a different path was written", ["see https://margin.example.com/other"]],
    ["only a lookalike host was written", ["https://margin.example.com.evil.example/mcp"]]
  ])("is refused as not from the owner when %s", (_case, ownerWords) => {
    expect(ask({ ownerWords })).toEqual({ kind: "refused", reason: "not_from_owner" })
  })

  it.each([
    ["plain http", "http://margin.example.com/mcp"],
    ["another scheme", "ftp://margin.example.com/mcp"],
    ["an address with a password", "https://me:secret@margin.example.com/mcp"]
  ])("is refused as invalid for %s, even if the owner wrote it", (_case, url) => {
    expect(ask({ url, ownerWords: [url] })).toEqual({ kind: "refused", reason: "invalid_url" })
  })

  it("accepts plain http only on this machine", () => {
    const local = "http://localhost:8787/mcp"
    expect(ask({ url: local, ownerWords: [`try ${local}`] })).toMatchObject({
      kind: "accepted",
      name: "localhost"
    })
  })

  it("is refused for a child agent, whatever the owner wrote", () => {
    expect(ask({ childAgent: true })).toEqual({ kind: "refused", reason: "child_agent" })
  })

  it("takes the model's label only as a short lowercase slug", () => {
    expect(ask({ name: "My Margin!" })).toMatchObject({ name: "my-margin" })
    expect(ask({ name: "123" })).toMatchObject({ name: "margin" })
  })
})
