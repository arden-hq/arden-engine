import assert from "node:assert/strict"
import { test } from "node:test"
import { offeredTools } from "../profile.mjs"

const catalog = [
  { name: "file_read", source: "_filesystem" },
  { name: "session_read", source: "_sessions" },
  { name: "session_archive", source: "_sessions" },
  { name: "email_send", source: "gmail" }
]

test("an allow-list offers only its tools", () => {
  assert.deepEqual([...offeredTools({ tools: ["file_read"] }, catalog)], ["file_read"])
})

test("a block-list offers the catalog minus blocked sources and tools", () => {
  const blockedTools = { sources: ["gmail"], tools: ["session_archive"] }
  assert.deepEqual([...offeredTools({ blockedTools }, catalog)], ["file_read", "session_read"])
})

test("an unknown tool or source is an error", () => {
  const blocked = (sources, tools) => ({ blockedTools: { sources, tools } })
  assert.throws(() => offeredTools({ tools: ["nope"] }, catalog), /Unknown profile tool: nope/)
  assert.throws(() => offeredTools(blocked([], ["nope"]), catalog), /Unknown profile tool: nope/)
  assert.throws(() => offeredTools(blocked(["nope"], []), catalog), /Unknown profile tool source/)
})
